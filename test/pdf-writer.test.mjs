// pdf-lib backend of the enhanced export (replaces the former Python backend tests).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import {fileURLToPath} from 'node:url';
import {PDFDocument,PDFName,PDFDict,PDFHexString,PDFString,PDFArray,PDFRef,degrees} from 'pdf-lib';

const built=await esbuild.build({entryPoints:[fileURLToPath(new URL('../src/pdf-writer.ts',import.meta.url))],
  bundle:true,write:false,format:'esm',platform:'node',external:['pdf-lib']});
const {writeAnnotatedPDF}=await import('data:text/javascript;base64,'+Buffer.from(
  built.outputFiles[0].text.replace(/from "pdf-lib"/g,`from "${import.meta.resolve('pdf-lib')}"`)).toString('base64'));

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC','base64');
const ann={category:'method',page:0,rects:[[20.25,700.5,100.75,712.5],[320,680,410,692]],
  quote:'Verified original sentence',summary:'中文分析与批注',layer:'L2'};
const str=v=>v instanceof PDFHexString || v instanceof PDFString ? v.decodeText() : String(v);

async function source() {
  const doc=await PDFDocument.create();
  doc.setTitle('Original title');
  const page=doc.addPage([600,800]);
  page.setCropBox(10,20,580,760);
  page.setRotation(degrees(90));
  // An existing bookmark that must survive.
  const ctx=doc.context;
  const outlinesRef=ctx.nextRef(),itemRef=ctx.nextRef();
  ctx.assign(itemRef,ctx.obj({Title:PDFHexString.fromText('Original bookmark'),Parent:outlinesRef,Dest:[page.ref,'Fit']}));
  ctx.assign(outlinesRef,ctx.obj({Type:'Outlines',First:itemRef,Last:itemRef,Count:1}));
  doc.catalog.set(PDFName.of('Outlines'),outlinesRef);
  return doc.save();
}
function outlineTitles(doc) {
  const out=[];
  const walk=(ref,depth)=>{
    while(ref instanceof PDFRef) {
      const item=doc.context.lookup(ref,PDFDict);
      out.push('  '.repeat(depth)+str(item.lookup(PDFName.of('Title'))));
      walk(item.get(PDFName.of('First')),depth+1);
      ref=item.get(PDFName.of('Next'));
    }
  };
  walk(doc.catalog.lookup(PDFName.of('Outlines'),PDFDict).get(PDFName.of('First')),0);
  return out;
}
const annots=(doc,i=0)=>{const a=doc.getPage(i).node.Annots();return a ? a.asArray().map(r=>doc.context.lookup(r,PDFDict)) : [];};

test('fractional geometry, colour, opacity, contents and appearance stream',async()=>{
  const report=await writeAnnotatedPDF(await source(),{annotations:[ann]});
  const doc=await PDFDocument.load(report.bytes);
  const a=annots(doc)[0];
  assert.equal(a.lookup(PDFName.of('Subtype')).asString(),'/Highlight');
  assert.equal(a.lookup(PDFName.of('CA')).asNumber(),0.3);
  assert.equal(a.lookup(PDFName.of('C'),PDFArray).lookup(1).asNumber(),0.659);
  const quads=a.lookup(PDFName.of('QuadPoints'),PDFArray);
  assert.equal(quads.size(),16);assert.equal(quads.lookup(0).asNumber(),20.25);
  const contents=str(a.lookup(PDFName.of('Contents')));
  assert.match(contents,/中文分析与批注/);assert.match(contents,/Verified original sentence/);
  assert.ok(a.lookup(PDFName.of('AP'),PDFDict).get(PDFName.of('N')) instanceof PDFRef);
  assert.equal(report.annotated,1);assert.deepEqual(report.layers,{L2:1,L3:0});
});
test('original metadata, bookmarks, rotation and crop box are preserved; source bytes untouched',async()=>{
  const src=await source();const before=Buffer.from(src);
  const report=await writeAnnotatedPDF(src,{annotations:[ann]});
  const doc=await PDFDocument.load(report.bytes);
  assert.equal(doc.getTitle(),'Original title');
  const titles=outlineTitles(doc);
  assert.equal(titles[0],'Original bookmark');
  assert.deepEqual(titles.slice(1),['PaperPilot 阅读导航（AI 分析）','  研究方法','    中文分析与批注']);
  assert.equal(doc.getPage(0).getRotation().angle,90);
  assert.deepEqual(doc.getPage(0).getCropBox(),{x:10,y:20,width:580,height:760});
  assert.ok(before.equals(Buffer.from(src)));
});
test('a PDF without bookmarks gets a fresh outline',async()=>{
  const d=await PDFDocument.create();d.addPage([600,800]);
  const doc=await PDFDocument.load((await writeAnnotatedPDF(await d.save(),{annotations:[ann]})).bytes);
  assert.equal(outlineTitles(doc)[0],'PaperPilot 阅读导航（AI 分析）');
});
test('underlines have an appearance and accurate counts',async()=>{
  const report=await writeAnnotatedPDF(await source(),{annotations:[{...ann,category:'highlight',layer:'L3'}]});
  const doc=await PDFDocument.load(report.bytes);
  const a=annots(doc)[0];
  assert.equal(a.lookup(PDFName.of('Subtype')).asString(),'/Underline');
  assert.deepEqual(report.layers,{L2:0,L3:1});
  const stream=doc.context.lookup(a.lookup(PDFName.of('AP'),PDFDict).get(PDFName.of('N')));
  assert.match(Buffer.from(stream.getContents()).toString('latin1'),/ l S/);
});
test('no automatic bilingual duplicate',async()=>{
  const doc=await PDFDocument.load((await writeAnnotatedPDF(await source(),{annotations:[{...ann,bilingual:true}]})).bytes);
  assert.equal(annots(doc).length,1);
});
test('rejects empty or invalid annotations',async()=>{
  for(const bad of [[],[{...ann,page:-1}],[{...ann,page:5}],[{...ann,layer:'L1'}],[{...ann,category:'other'}],
    [{...ann,rects:[[0,0,NaN,9]]}],[{...ann,rects:[[500,700,400,712]]}],[{...ann,rects:[]}]]) {
    await assert.rejects(writeAnnotatedPDF(await source(),{annotations:bad}));
  }
});
test('mindmap appendix and reading guide are embedded',async()=>{
  const report=await writeAnnotatedPDF(await source(),{annotations:[ann],mindmap:PNG,guide:'阅读指引：点击高亮查看分析'});
  const doc=await PDFDocument.load(report.bytes);
  assert.equal(doc.getPageCount(),2);assert.equal(report.pages,2);assert.ok(report.mindmap);
  const xobjects=doc.getPage(1).node.Resources().lookup(PDFName.of('XObject'),PDFDict);
  assert.ok(xobjects.keys().length>0);
  const guide=annots(doc).at(-1);
  assert.equal(guide.lookup(PDFName.of('Subtype')).asString(),'/Text');
  assert.match(str(guide.lookup(PDFName.of('Contents'))),/阅读指引/);
  assert.equal(outlineTitles(doc).at(-1),'  PaperPilot 思维导图（附页）');
});
test('unreadable input reports a clear error',async()=>{
  await assert.rejects(writeAnnotatedPDF(new Uint8Array([1,2,3]),{annotations:[ann]}),/无法读取 PDF/);
});
