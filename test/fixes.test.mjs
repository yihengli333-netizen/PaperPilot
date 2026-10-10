import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as esbuild from 'esbuild';
import {fileURLToPath} from 'node:url';

const sources = new Map();
test('enhanced export loads before Zotero rootURI and filesystem are available',async()=>{
  const m=await load('enhanced-export');
  assert.equal(typeof m.annotatePDFAdvanced,'function');
});
test('enhanced export preserves separate line rectangles and counts skipped evidence',async()=>{
  const m=await load('enhanced-export');
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
test('supporting evidence is annotated in its category colour layer',async()=>{
  const m=await load('enhanced-export');
  const second='A second verified sentence.';
  const data={method:{summary:'Main',quote,verified:true,page:1,evidence:[{summary:'Extra',quote:second,verified:true,page:2}]},highlights:[]};
  const out=await m.convertAnnotations(data,{reader:reader([quote,second])});
  assert.deepEqual(JSON.parse(JSON.stringify(out.annotations.map(a=>[a.category,a.page,a.summary,a.layer]))),[['method',0,'Main','L2'],['method',1,'Extra','L2']]);
});
test('enhanced export writes with pdf-lib, imports a separate PDF and cleans staging',async()=>{
  const {PDFDocument}=await import('pdf-lib');
  const src=await PDFDocument.create();src.addPage([612,792]);
  const sourceBytes=await src.save();
  const files=new Map();let imported=null;
  const z={debug(){},getTempDirectory:()=>({path:'/tmp'}),DataObjectUtilities:{generateKey:()=> 'unique'},
    getMainWindow:()=>({Image:class {set src(v){void v;setTimeout(()=>this.onload(),0);}},document:{createElementNS:()=>({
      getContext:()=>({fillRect(){},scale(){},drawImage(){}}),toDataURL:()=> 'data:image/png;base64,'+PNG})}}),
    PDFWorker:{export:async(id,path,priority,password,transfer)=>{assert.equal(id,7);assert.equal(transfer,false);files.set(path,sourceBytes);}},
    Attachments:{importFromFile:async opts=>{
      assert.equal(opts.parentItemID,16);assert.ok(files.has(opts.file));imported=files.get(opts.file);
      return {id:90,addTag:tag=>assert.equal(tag,'PaperPilot Export'),saveTx:async()=>{},getFilePathAsync:async()=>'/library/new.pdf'};
    }}};
  const m=await load('enhanced-export',z,{atob:s=>Buffer.from(s,'base64').toString('binary'),
    PathUtils:{join:(...p)=>p.join('/')},IOUtils:{makeDirectory:async()=>{},
      read:async p=>files.get(p),write:async(p,v)=>files.set(p,v),
      remove:async dir=>{for(const p of files.keys())if(p.startsWith(dir+'/'))files.delete(p);}}});
  const att={id:7,libraryID:1,parentItem:{id:16,isRegularItem:()=>true,getDisplayTitle:()=> 'Test paper'}};
  const out=await m.annotatePDFAdvanced(att,result(),{reader:reader()});
  assert.equal(out.path,'/library/new.pdf');assert.equal(out.annotated,1);assert.deepEqual({...out.layers},{L2:1,L3:0});
  assert.equal(files.size,0);
  const written=await PDFDocument.load(new Uint8Array(imported));
  assert.equal(written.getPageCount(),2,'mindmap appended as last page');
  assert.equal(written.getPage(0).node.Annots().size(),2,'highlight + reading guide');
});
// 1x1 white PNG
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
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
    readUTF8:async()=>JSON.stringify({'v3:PDFKEY:123:5:mock:zh:p3':{result:cached}})}});
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
test('cache key changes with model, language and prompt version but not between identical configs',async()=>{
  const m=await load('store',{},{IOUtils:{stat:async()=>({size:10,lastModified:2})}});
  const att={key:'K',getFilePathAsync:async()=>'/p.pdf'};
  const a=await m.makeKey(att,{model:'gpt-4o-mini',language:'zh'});
  assert.equal(a,await m.makeKey(att,{model:'gpt-4o-mini',language:'zh'}));
  assert.notEqual(a,await m.makeKey(att,{model:'deepseek-chat',language:'zh'}));
  assert.notEqual(a,await m.makeKey(att,{model:'gpt-4o-mini',language:'en'}));
  assert.match(a,/:p\d+$/);
});
function llmEnv(responses) {
  const calls=[];
  const fetch=async(url,opts)=>{
    const body=JSON.parse(opts.body);calls.push({body,signal:opts.signal});
    const next=responses.shift();
    if(next==='hang') return new Promise((_,reject)=>opts.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'}))));
    return {ok:next.status===200,status:next.status,text:async()=>typeof next.body==='string' ? next.body : JSON.stringify(next.body)};
  };
  const z={getMainWindow:()=>({AbortController})};
  return {calls,z,extra:{fetch}};
}
const reply=content=>({status:200,body:{choices:[{message:{content}}]}});
const cfg={endpoint:'https://llm.test/v1',apiKey:'k',model:'m',language:'zh',maxInputChars:1000,timeoutMs:60,highlightCount:6};
test('JSON mode is requested and dropped (and remembered) when the endpoint rejects it',async()=>{
  const {calls,z,extra}=llmEnv([{status:400,body:{error:{message:'Unknown parameter'}}},reply('{"a":1}'),reply('{"a":2}')]);
  const m=await load('llm',z,extra);
  assert.equal((await m.callLLM(cfg,'meta','body',6)).a,1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].body.response_format)),{type:'json_object'});
  assert.equal(calls[1].body.response_format,undefined);
  assert.equal((await m.callLLM(cfg,'meta','body',6)).a,2);
  assert.equal(calls[2].body.response_format,undefined,'unsupported endpoint is remembered');
});
test('a genuine HTTP error is still reported after the JSON-mode retry',async()=>{
  const {z,extra}=llmEnv([{status:400,body:{error:{message:'model not found'}}},{status:400,body:{error:{message:'model not found'}}}]);
  const m=await load('llm',z,extra);
  await assert.rejects(m.callLLM(cfg,'meta','body',6),/400.*model not found/);
});
test('the non-JSON retry gets its own full timeout',async()=>{
  // First reply takes ~70% of the timeout and is not JSON; the retry must not inherit the remaining 30%.
  const {calls,z,extra}=llmEnv([]);
  const slowFetch=async(url,opts)=>{
    calls.push(opts);
    await new Promise((resolve,reject)=>{
      const t=setTimeout(resolve,42);
      opts.signal.addEventListener('abort',()=>{clearTimeout(t);reject(Object.assign(new Error('aborted'),{name:'AbortError'}));});
    });
    const content=calls.length===1 ? 'not json' : '{"ok":true}';
    return {ok:true,status:200,text:async()=>JSON.stringify({choices:[{message:{content}}]})};
  };
  const m=await load('llm',z,{fetch:slowFetch});
  assert.equal((await m.callLLM(cfg,'meta','body',6)).ok,true);
  assert.equal(calls.length,2);
});
test('a page without text-layer data does not prevent locating quotes on other pages',async()=>{
  const m=await load('geo');
  const r=reader(['Cover page placeholder',quote]);
  const pdf=r._internalReader._primaryView._iframeWindow.PDFViewerApplication.pdfDocument;
  const orig=pdf.getPageData;
  pdf.getPageData=async args=>args.pageIndex===0 ? {} : orig(args);
  const loc=await m.locateQuote({reader:r},quote,0);
  assert.equal(loc?.pageIndex,1);
});
test('geo locates quotes across line-break hyphenation and ligatures',async()=>{
  const m=await load('geo');
  const loc=await m.locateQuote({reader:reader(['The proposed meth-od uses a ﬁxed solver here.'])},'proposed method uses a fixed solver',0);
  assert.equal(loc?.pageIndex,0);
});
test('legacy default limits are migrated once; customised values are kept',async()=>{
  const store={'extensions.zotero.paperpilot.maxInputChars':30000,'extensions.zotero.paperpilot.timeoutMs':90000};
  const z={Prefs:{get:k=>store[k],set:(k,v)=>{store[k]=v;}}};
  const m=await load('prefs',z);
  m.initPrefs();
  assert.equal(store['extensions.zotero.paperpilot.maxInputChars'],100000);
  assert.equal(store['extensions.zotero.paperpilot.timeoutMs'],90000);
  store['extensions.zotero.paperpilot.maxInputChars']=30000;m.initPrefs();
  assert.equal(store['extensions.zotero.paperpilot.maxInputChars'],30000,'a later explicit 30000 is respected');
  assert.equal(m.getConfig().highlightCount,6);
});
test('unconfigured users move from the old OpenAI default to the relay; configured keys are untouched',async()=>{
  const fresh={'extensions.zotero.paperpilot.endpoint':'https://api.openai.com/v1/chat/completions','extensions.zotero.paperpilot.model':'gpt-4o-mini','extensions.zotero.paperpilot.apiKey':''};
  const keyed={...fresh,'extensions.zotero.paperpilot.apiKey':'sk-existing'};
  for(const store of [fresh,keyed]) {
    const m=await load('prefs',{Prefs:{get:k=>store[k],set:(k,v)=>{store[k]=v;}}});
    m.initPrefs();
  }
  assert.equal(fresh['extensions.zotero.paperpilot.endpoint'],'https://ccg-cli.online/v1/chat/completions');
  assert.equal(fresh['extensions.zotero.paperpilot.model'],'qwen3.8-flash');
  assert.equal(keyed['extensions.zotero.paperpilot.endpoint'],'https://api.openai.com/v1/chat/completions');
  assert.equal(keyed['extensions.zotero.paperpilot.model'],'gpt-4o-mini');
});
test('model list URL is derived from the chat endpoint',async()=>{
  const m=await load('types');
  assert.equal(m.modelsURL('https://ccg-cli.online/v1/chat/completions'),'https://ccg-cli.online/v1/models');
  assert.equal(m.modelsURL(' http://localhost:11434/v1/chat/completions/ '),'http://localhost:11434/v1/models');
  assert.equal(m.modelsURL('https://example.test/custom'),null);
});
