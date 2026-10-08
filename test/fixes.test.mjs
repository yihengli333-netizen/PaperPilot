import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as esbuild from 'esbuild';
import {fileURLToPath} from 'node:url';

const sources = new Map();
test('Python bridge loads before Zotero rootURI and filesystem are available',async()=>{
  const m=await load('python_bridge');
  assert.equal(typeof m.annotatePDFAdvanced,'function');
});
test('Python bridge preserves separate line rectangles and counts skipped evidence',async()=>{
  const m=await load('python_bridge');
  const r=reader();
  const pdf=r._internalReader._primaryView._iframeWindow.PDFViewerApplication.pdfDocument;
  const orig=pdf.getPageData;
  pdf.getPageData=async args=>{
    const data=await orig(args);
    data.chars.forEach((c,i)=>{if(i>=10)c.rect=[300+(i-10)*6,680,306+(i-10)*6,692];});
    return data;
  };
  const data={...result(),highlights:[{quote:'unverified',verified:false}]};
  const out=await m.convertAnnotations(data,{reader:r});
  assert.equal(out.annotations.length,1);assert.equal(out.skipped,1);
  assert.equal(out.annotations[0].rects.length,2);
  assert.equal(out.annotations[0].rects[1][0],300);
});
test('Python bridge uses Unicode async launch and reports failure',async()=>{
  const args=['中文 path/script.py'];let called=false;
  const z={File:{pathToFile:path=>path}};
  const proc={init(){},exitValue:1,runwAsync(actual,count,observer){
    assert.equal(actual,args);assert.equal(count,1);called=true;
    setTimeout(()=>observer.observe(null,'process-finished'),0);
  }};
  const m=await load('python_bridge',z,{Components:{classes:{'@mozilla.org/process/util;1':{createInstance:()=>proc}},interfaces:{}}});
  assert.equal(await m.runPython('/python',args),1);assert.ok(called);
});
test('enhanced export extracts jar resources, imports a separate PDF and cleans staging',async()=>{
  const files=new Map([['/python',true]]);let resourceRead=false,imported=false;
  const z={Prefs:{get:()=>'/python'},PaperPilot:{rootURI:'jar:file:///plugin@id.xpi!/'},debug(){},
    File:{pathToFile:p=>p,getResourceAsync:async uri=>{
      assert.equal(uri,'jar:file:///plugin@id.xpi!/tools/pdf_annotator.py');resourceRead=true;return 'script';}},
    getTempDirectory:()=>({path:'/tmp'}),DataObjectUtilities:{generateKey:()=> 'unique'},
    getMainWindow:()=>({Image:class {set src(v){void v;setTimeout(()=>this.onload(),0);}},document:{createElementNS:()=>({
      getContext:()=>({fillRect(){},scale(){},drawImage(){}}),toDataURL:()=> 'data:image/png;base64,YQ=='})}}),
    PDFWorker:{export:async(id,path,priority,password,transfer)=>{assert.equal(id,7);assert.equal(transfer,false);files.set(path,'source');}},
    Attachments:{importFromFile:async opts=>{
      assert.notEqual(opts.file,'/original.pdf');assert.equal(opts.parentItemID,16);assert.ok(files.has(opts.file));imported=true;
      return {id:90,addTag:tag=>assert.equal(tag,'PaperPilot Export'),saveTx:async()=>{},getFilePathAsync:async()=>'/library/new.pdf'};
    }}};
  const proc={init(){},exitValue:0,runwAsync(args,count,observer){
    const request=files.get(args[4]);assert.equal(request.annotations.length,1);
    assert.equal(request.annotations[0].layer,'L2');assert.ok(files.has(request.mindmapPath));
    files.set(args[5],'new pdf');files.set(args[6],{ok:true,annotated:1,layers:{L2:1,L3:0},mindmap:true});
    setTimeout(()=>observer.observe(null,'process-finished'),0);
  }};
  const m=await load('python_bridge',z,{atob:s=>Buffer.from(s,'base64').toString('binary'),
    PathUtils:{join:(...p)=>p.join('/')},IOUtils:{exists:async p=>files.has(p),makeDirectory:async()=>{},
      writeUTF8:async(p,v)=>files.set(p,v),write:async(p,v)=>files.set(p,v),writeJSON:async(p,v)=>files.set(p,v),readJSON:async p=>files.get(p),
      remove:async dir=>{for(const p of files.keys())if(p.startsWith(dir+'/'))files.delete(p);}},
    Components:{classes:{'@mozilla.org/process/util;1':{createInstance:()=>proc}},interfaces:{}}});
  const att={id:7,libraryID:1,parentItem:{id:16,isRegularItem:()=>true,getDisplayTitle:()=> 'Test paper'}};
  const out=await m.annotatePDFAdvanced(att,result(),{reader:reader()});
  assert.equal(out.path,'/library/new.pdf');assert.ok(resourceRead && imported);assert.equal(files.size,1);
});
async function load(name, Zotero = {}, extra = {}) {
  if (!sources.has(name)) {
    const r = await esbuild.build({entryPoints:[fileURLToPath(new URL(`../src/${name}.ts`,import.meta.url))],bundle:true,write:false,format:'cjs',platform:'node',define:{__PP_VERSION__:'"test"'}});
    sources.set(name,r.outputFiles[0].text);
  }
  const ctx = {module:{exports:{}},exports:{},Zotero,setTimeout,clearTimeout,...extra};
  vm.runInNewContext(sources.get(name),ctx);
  return ctx.module.exports;
}
const fixture = name => fs.readFileSync(new URL(`fixtures/zotero-10.0.2/${name}`,import.meta.url),'utf8');
function realAPIs(z) {
  const ctx=vm.createContext({Zotero:z,CSS:{escape:s=>s},ChromeUtils:{
    defineESModuleGetters:o=>{o.Zotero=z;},importESModule:()=>({PluginAPIBase:ctx.PluginAPIBase})
  }});
  vm.runInContext(fixture('pluginAPIBase.mjs').replace('export { PluginAPIBase };','globalThis.PluginAPIBase=PluginAPIBase;'),ctx);
  vm.runInContext(fixture('itemPaneManager.js'),ctx);
  z.defineProperty=Object.defineProperty;
  vm.runInContext(fixture('annotations.js'),ctx);
}
function environment({failSave=false}={}) {
  let counter=0;
  const stored=[];
  const z={debug(){},warn(){},logError(){},Utilities:{randomString:()=> 'random'},Plugins:{addObserver(){}},
    Notifier:{queue(){}},DB:{executeTransaction:async fn=>fn()},
    DataObjectUtilities:{generateKey:()=>`TEST${String(++counter).padStart(4,'0')}`},
    Items:{getByLibraryAndKey:(lib,key)=>stored.find(a=>a.key===key)},
    Item:class {
      async loadPrimaryData(){} _requireData(){} setTags(tags){this.tags=tags;}
      hasTag(tag){return this.tags?.some(t=>t.tag===tag);}
      async saveTx(){if(failSave) throw Error('disk full');stored.push(this);}
      async eraseTx(){stored.splice(stored.indexOf(this),1);}
    }
  };
  realAPIs(z);
  const att={id:99,libraryID:1,getAnnotations:()=>stored};
  return {z,att,stored};
}
const quote='This is a known original quote.';
const result = (verified=true) => ({research_question:{summary:'Test',quote,page:1,verified},highlights:[]});
function reader(pages=[quote]) {
  const chars=s=>Array.from(s,(c,i)=>({c,u:c,rect:[i*6,700,i*6+6,712],inlineRect:[0,700,s.length*6,712],rotation:0,lineBreakAfter:i===s.length-1}));
  const pdfDocument={numPages:pages.length,
    getPageData:async ({pageIndex})=>({chars:chars(pages[pageIndex]),viewBox:[0,0,612,792]}),
    getPage:async n=>({view:[0,0,612,792],getTextContent:async()=>({items:[{str:pages[n-1],transform:[1,0,0,12,0,700],width:pages[n-1].length*6}]})})};
  return {_internalReader:{_primaryView:{_iframeWindow:{PDFViewerApplication:{pdfDocument}}}}};
}
test('real Zotero API accepts section registration',async()=>{
  const {z}=environment();const ui=await load('ui',z);ui.registerSection();
  assert.equal(z.ItemPaneManager._sectionManager.options.length,1);
});
test('section registration failure is surfaced',async()=>{
  const ui=await load('ui',{ItemPaneManager:{registerSection:()=>false}});
  assert.throws(()=>ui.registerSection(),/PaperPilot/);
});
test('Fluent labels do not replace section or navigation children',()=>{
  for(const lang of ['en-US','zh-CN']) {
    const ftl=fs.readFileSync(new URL(`../addon/locale/${lang}/paperpilot.ftl`,import.meta.url),'utf8');
    assert.match(ftl,/paperpilot-section-header =\s*\n\s+\.label/);
    assert.match(ftl,/paperpilot-section-sidenav =\s*\n\s+\.tooltiptext/);
  }
});
test('real annotation API receives valid key and coordinate object',async()=>{
  const {z,att,stored}=environment();const m=await load('annotate',z);
  const stats=await m.annotatePDF(att,result(),{reader:reader(),fullText:quote,totalPages:1});
  assert.equal(stats.created,1);assert.match(stored[0].key,/^[A-Z0-9]{8}$/);
  const position=JSON.parse(stored[0].annotationPosition);
  assert.equal(position.pageIndex,0);assert.ok(position.rects.length);
  assert.match(stored[0].annotationSortIndex,/^\d{5}\|\d{6}\|\d{5}$/);
});
test('save failure leaves existing annotations intact and reports failure',async()=>{
  const {z,att,stored}=environment({failSave:true});const m=await load('annotate',z);
  const old={annotationComment:'[PP·方法] old',eraseTx:async()=>stored.splice(0,1)};stored.push(old);
  const stats=await m.annotatePDF(att,result(),{reader:reader(),fullText:quote,totalPages:1});
  assert.equal(stats.failed,1);assert.match(stats.errors[0],/disk full/);
  assert.ok(stored.includes(old));
});
test('no match leaves existing annotations intact',async()=>{
  const {z,att,stored}=environment();const m=await load('annotate',z);
  const old={annotationComment:'[PP·方法] old',eraseTx:async()=>stored.splice(0,1)};stored.push(old);
  const stats=await m.annotatePDF(att,result(),{reader:reader(['different content']),fullText:'different content',totalPages:1});
  assert.equal(stats.created,0);assert.ok(stored.includes(old));
});
test('repeated and concurrent writes do not duplicate or replace existing highlights',async()=>{
  const {z,att,stored}=environment();const m=await load('annotate',z);
  const ctx={reader:reader(),fullText:quote,totalPages:1};
  await m.annotatePDF(att,result(),ctx);const first=stored[0];
  await Promise.all([m.annotatePDF(att,result(),ctx),m.annotatePDF(att,result(),ctx)]);
  assert.equal(stored.length,1);assert.equal(stored[0],first);
});
test('unverified quotes never become annotations',async()=>{
  const {z,att,stored}=environment();const m=await load('annotate',z);
  await m.annotatePDF(att,result(false),{reader:reader(),fullText:quote,totalPages:1});
  assert.equal(stored.length,0);
});
test('clear preserves handwritten comments even with the legacy prefix',async()=>{
  const {z,att,stored}=environment();const m=await load('annotate',z);
  const manual={annotationComment:'[PP·方法] my own note',eraseTx:async()=>stored.splice(0,1)};stored.push(manual);
  assert.equal(await m.clearPilotAnnotations(att),0);assert.ok(stored.includes(manual));
});
test('unopened PDF never falls back to guessed page coordinates',async()=>{
  const m=await load('geo');
  assert.equal(await m.locateQuote({reader:null,fullText:'Short page.\f'+quote+'x'.repeat(5000),totalPages:2},quote,2),null);
});
test('prefix-only match is rejected',async()=>{
  const m=await load('geo');const prefix='abcdefghijklmnopqrstuvwxyz1234';
  assert.equal(await m.locateQuote({reader:reader([prefix+' real ending']),fullText:prefix+' real ending',totalPages:1},prefix+' invented ending',1),null);
});
test('native character coordinates select the quote, not the entire text item',async()=>{
  const m=await load('geo');const text='prefix '+quote+' suffix';
  const loc=await m.locateQuote({reader:reader([text]),fullText:text,totalPages:1},quote,1);
  assert.equal(loc.pageIndex,0);assert.equal(loc.rects[0][0],7*6);
  assert.equal(loc.rects.at(-1)[2],(7+quote.length)*6);
});
test('all pages are searched when a page hint is incorrect or out of range',async()=>{
  const m=await load('geo');const r=reader([quote,'no match']);
  const loc=await m.locateQuote({reader:r,fullText:quote,totalPages:2},quote,900);
  assert.equal(loc?.pageIndex,0);
});

test('PDF worker arguments are cloned into the reader compartment',async()=>{
  const r=reader();const win=r._internalReader._primaryView._iframeWindow;
  const get=win.PDFViewerApplication.pdfDocument.getPageData;
  const nativeArgs=new WeakSet();let cloned=false;
  win.PDFViewerApplication.pdfDocument.getPageData=async args=>{
    if(!nativeArgs.has(args)) throw Error('DataCloneError: The object could not be cloned.');
    return get(args);
  };
  const m=await load('geo',{}, {Components:{utils:{cloneInto:(args,target)=>{
    assert.equal(target,win);const copy={...args};nativeArgs.add(copy);cloned=true;return copy;
  }}}});
  assert.ok(await m.locateQuote({reader:r},quote,1));assert.ok(cloned);
});
test('ambiguous quote without a page hint is not silently assigned to its first occurrence',async()=>{
  const m=await load('geo');
  assert.equal(await m.locateQuote({reader:reader([quote,quote]),fullText:quote,totalPages:2},quote,0),null);
});
test('mindmap retains complete long summaries',async()=>{
  const m=await load('mindmap');const r=result();r.research_question.summary='内容'.repeat(40)+'最终结论';
  const tree=m.buildTree(r,'Title');assert.equal(tree.children[0].children[0].label,r.research_question.summary);
  assert.ok(m.buildMindmap(r,'Title').svg.includes('最终结论'));
});

test('a page with multiple matches makes unhinted global location ambiguous',async()=>{
  const m=await load('geo');
  assert.equal(await m.locateQuote({reader:reader([quote+' '+quote,quote]),fullText:quote,totalPages:2},quote,0),null);
});
test('Reader data is usable even when visual initialization never resolves',async()=>{
  const r=reader();r._initPromise=new Promise(()=>{});
  const m=await load('nav',{Reader:{_readers:[],open:async()=>r}});
  assert.equal(await m.ensureReader(99,30),r);
});
test('restored unloaded PDF tabs can return undefined before the reader appears',async()=>{
  const r=reader();r.itemID=99;const list=[];
  const m=await load('nav',{Reader:{_readers:list,open:async()=>{setTimeout(()=>list.push(r),5);}}});
  assert.equal(await m.ensureReader(99,500),r);
});
test('missing PDF data has a bounded timeout',async()=>{
  const m=await load('nav',{Reader:{_readers:[],open:async()=>({_initPromise:new Promise(()=>{})})}});
  await assert.rejects(()=>m.ensureReader(99,5),/超时/);
});
test('clear removes owned annotations and preserves manual ones',async()=>{
  const {z,att,stored}=environment();const m=await load('annotate',z);
  const manual={annotationComment:'Manual note'};stored.push(manual);
  await m.annotatePDF(att,result(),{reader:reader(),fullText:quote,totalPages:1});
  assert.equal(await m.clearPilotAnnotations(att),1);assert.deepEqual(stored,[manual]);
});
test('column gaps are never painted across',async()=>{
  const r=reader();const pdf=r._internalReader._primaryView._iframeWindow.PDFViewerApplication.pdfDocument;
  const get=pdf.getPageData;
  pdf.getPageData=async args=>{
    const data=await get(args);
    data.chars.forEach((c,i)=>{if(i>10) {c.rect[0]+=250;c.rect[2]+=250;}});
    return data;
  };
  const m=await load('geo');const loc=await m.locateQuote({reader:r,fullText:quote,totalPages:1},quote,1);
  assert.equal(loc.rects.length,2);assert.ok(loc.rects[1][0]-loc.rects[0][2]>200);
});
test('wrapped mindmap nodes fit the canvas without overlap',async()=>{
  const m=await load('mindmap');const r=result();
  r.research_question.summary='这是需要保留的详细解释。'.repeat(30);
  r.highlights=[{title:'Topic',description:'More detail '.repeat(30)},{title:'Next topic',description:'Second detail '.repeat(30)}];
  const tree=m.buildTree(r,'Long title '.repeat(30));const size=m.layout(tree);
  const nodes=[];const visit=n=>{nodes.push(n);n.children.forEach(visit);};visit(tree);
  for(const n of nodes) {assert.ok(n.x+n.w<=size.width);assert.ok(n.y+n.h<=size.height);}
  for(let i=0;i<nodes.length;i++) for(let j=i+1;j<nodes.length;j++) {
    const a=nodes[i],b=nodes[j];
    assert.ok(a.x+a.w<=b.x || b.x+b.w<=a.x || a.y+a.h<=b.y || b.y+b.h<=a.y);
  }
});

function dom() {
  const doc={createElementNS:(_,tag)=>element(tag)};
  function element(tag='div') {
    const el={tagName:tag,ownerDocument:doc,children:[],dataset:{},isConnected:true,
      className:'',innerHTML:'',style:{},setAttribute(k,v){this[k]=v;},addEventListener(){},
      replaceChildren(...children){this.children=children;},appendChild(c){this.children.push(c);return c;},
      get firstElementChild(){return this.children[0];},
      querySelector(selector){return this.querySelectorAll(selector)[0] || null;},
      querySelectorAll(selector){
        const matches=[];
        const walk=n=>{
          if(selector==='[data-pp-act]' && n.dataset.ppAct || selector.startsWith('.') && n.className===selector.slice(1)) matches.push(n);
          n.children.forEach(walk);
        };
        this.children.forEach(walk);return matches;
      }};
    return el;
  }
  return {doc,element};
}
test('cached and newly analyzed results retain the same clear-highlight action',async()=>{
  const {doc,element}=dom();let section;
  const att={id:1,key:'PDFKEY',isAttachment:()=>true,attachmentContentType:'application/pdf',getFilePathAsync:async()=>'/paper.pdf'};
  const cached=result();const prefs={apiKey:'fake',endpoint:'https://example.test',model:'mock'};
  const z={ItemPaneManager:{registerSection:o=>{section=o;return 'pane';}},DataDirectory:{dir:'/tmp'},Prefs:{get:k=>prefs[k.split('.').at(-1)]}};
  const m=await load('ui',z,{PathUtils:{join:(...p)=>p.join('/')},IOUtils:{stat:async()=>({size:123,lastModified:5}),exists:async()=>true,
    readUTF8:async()=>JSON.stringify({'v2:PDFKEY:123:5':{result:cached}})}});
  m.registerSection();const body=element();section.onRender({item:att,body,doc});
  await section.onAsyncRender({item:att,body});
  const actions=()=>body.querySelectorAll('[data-pp-act]').map(e=>e.dataset.ppAct);
  const cachedActions=actions();assert.ok(cachedActions.includes('clearHl'));
  await m.runAnalyze(body.children[0],att,false,false);
  assert.deepEqual(actions(),cachedActions);
});
test('guide uses actual existing attachments, including PNG-only results',async()=>{
  let html='';const map={hasTag:()=>true,key:'MAPKEY12',libraryID:1,getField:()=> 'My diagram.png'};
  const z={Items:{get:()=>map},Libraries:{get:()=>({libraryType:'user'})},Item:class {setNote(s){html=s;}async saveTx(){}}};
  const item={libraryID:1,id:2,isRegularItem:()=>true,getDisplayTitle:()=> 'Paper',getAttachments:()=>[3]};
  const m=await load('ui',z);await m.saveGuideNote(item,result());
  assert.ok(html.includes('已生成'));assert.ok(!html.includes('尚未生成'));
  assert.ok(html.includes('zotero://select/library/items/MAPKEY12'));assert.ok(html.includes('My diagram.png'));
  item.getAttachments=()=>[];await m.saveGuideNote(item,result());assert.ok(html.includes('尚未生成'));
});
test('mindmap saves tagged attachment and cleans temporary files on success and failure',async()=>{
  for(const fail of [false,true]) {
    const files=new Map();const saved=[];
    const z={debug(){},getTempDirectory:()=>({path:'/tmp'}),getMainWindow:()=>null,
      DataObjectUtilities:{generateKey:()=> 'TEST1234'},Attachments:{importFromFile:async ({parentItemID})=>{
        assert.equal(parentItemID,2);if(fail) throw Error('disk full');
        return {addTag:t=>saved.push(t),saveTx:async()=>{}};
      }}};
    const m=await load('mindmap',z,{PathUtils:{join:(...p)=>p.join('/')},IOUtils:{makeDirectory:async()=>{},writeUTF8:async(p,s)=>files.set(p,s),remove:async p=>files.delete(p)}});
    const res=await m.saveMindmap({id:2,libraryID:1,isRegularItem:()=>true},{svg:'<svg/>',width:100,height:100});
    assert.equal(res.svgSaved,!fail);assert.equal(files.size,0);
    if(!fail) assert.ok(saved.includes('PaperPilot Mindmap'));
  }
});
test('standalone PDF receives a clear error before invalid child attachment import',async()=>{
  const m=await load('mindmap');
  await assert.rejects(()=>m.saveMindmap({isAttachment:()=>true},{svg:'<svg/>',width:10,height:10}),/文献条目/);
});

test('export writes a separate annotated PDF without transferring or overwriting source annotations',async()=>{
  const {z,att,stored}=environment();att.key='PDFKEY12';att.isAttachment=()=>true;
  att.attachmentContentType='application/pdf';att.getFilePathAsync=async()=>'/original.pdf';
  const parent={id:2,libraryID:1,isRegularItem:()=>true,getDisplayTitle:()=> 'Paper'};att.parentItem=parent;
  const r=reader();r.itemID=99;z.Reader={_readers:[r],open:async()=>r};
  z.getTempDirectory=()=>({path:'/tmp'});const files=new Set();
  z.PDFWorker={export:async(id,path,priority,password,transfer)=>{
    assert.equal(id,99);assert.notEqual(path,'/original.pdf');assert.equal(transfer,false);
    assert.ok(stored.some(a=>a.annotationType==='highlight'));
    assert.ok(stored.some(a=>a.annotationType==='note' && a.annotationComment.includes('阅读指引')));
    files.add(path);return stored.length;
  }};
  let imported=false;z.Attachments={importFromFile:async opts=>{
    assert.equal(opts.parentItemID,2);assert.ok(files.has(opts.file));imported=true;
    return {id:5,addTag(){},saveTx:async()=>{},getFilePathAsync:async()=>'/library/annotated.pdf'};
  }};
  const m=await load('pdf-export',z,{PathUtils:{join:(...p)=>p.join('/')},IOUtils:{exists:async p=>files.has(p),remove:async p=>files.delete(p)}});
  const output=await m.exportAnnotatedPDF(att,result());
  assert.ok(imported);assert.equal(output.path,'/library/annotated.pdf');assert.equal(files.size,0);
  assert.equal(output.stats.created,1);
});
test('export refuses to claim success when no quote has reliable coordinates',async()=>{
  const {z,att}=environment();att.isAttachment=()=>true;att.attachmentContentType='application/pdf';
  att.getFilePathAsync=async()=>'/original.pdf';const r=reader();r.itemID=99;
  z.Reader={_readers:[r],open:async()=>r};let called=false;z.PDFWorker={export:async()=>{called=true;}};
  const m=await load('pdf-export',z);
  await assert.rejects(()=>m.exportAnnotatedPDF(att,result(false)),/没有.*高亮/);
  assert.equal(called,false);
});
