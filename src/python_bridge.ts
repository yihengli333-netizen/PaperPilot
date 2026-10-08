import type { SummaryResult } from "./types";
import { locateQuote, type LocateContext, type PdfRect } from "./geo";
import { getPref } from "./prefs";
import { buildMindmap, svgToPng } from "./mindmap";
import { EXPORT_TAG } from "./pdf-export";

interface Annotation { category:string;page:number;rects:PdfRect[];quote:string;summary:string;layer:"L2"|"L3" }

export async function convertAnnotations(result:SummaryResult,ctx:LocateContext) {
  const annotations:Annotation[]=[];
  let skipped=0;
  const tasks=[...(["research_question","method","results","limitations"] as const)
    .map(category=>({category,finding:result[category]})),
    ...(result.highlights || []).map(finding=>({category:"highlight",finding}))];
  for(const {category,finding} of tasks) {
    if(!finding?.quote) continue;
    if(finding.verified !== true) {skipped++;continue;}
    const loc=await locateQuote(ctx,finding.quote,finding.page || 0);
    if(!loc) {skipped++;continue;}
    annotations.push({category,page:loc.pageIndex,rects:loc.rects,quote:finding.quote,
      summary:"summary" in finding ? finding.summary : finding.description,
      layer:category === "highlight" ? "L3" : "L2"});
  }
  return {annotations,skipped};
}

/** nsIProcess Unicode asynchronous API: Chinese paths work and the Zotero UI stays responsive. */
export function runPython(binary:string,args:string[],timeoutMs=120000):Promise<number> {
  return new Promise((resolve,reject)=>{
    const proc=Components.classes["@mozilla.org/process/util;1"].createInstance(Components.interfaces.nsIProcess);
    proc.init(Zotero.File.pathToFile(binary));
    let timedOut=false;
    const timer=setTimeout(()=>{
      timedOut=true;
      try {proc.kill();} catch(e) {reject(new Error("Python 超时且无法停止："+String(e)));}
    },timeoutMs);
    try {
      proc.runwAsync(args,args.length,{observe:(_subject:any,topic:string)=>{
        clearTimeout(timer);
        if(timedOut) reject(new Error("PDF 导出超过 120 秒，后端已停止"));
        else if(topic !== "process-finished") reject(new Error("Python 进程启动或运行失败"));
        else resolve(proc.exitValue);
      }},false);
    } catch(e) {clearTimeout(timer);reject(e);}
  });
}

export async function annotatePDFAdvanced(attachment:any,result:SummaryResult,ctx:LocateContext) {
  const binary=String(getPref("pythonPath") || "").trim();
  if(!binary || !(await IOUtils.exists(binary))) throw new Error("请在 PaperPilot 设置中填写已安装 pypdf 和 reportlab 的 Python 路径");
  const rootURI=Zotero.PaperPilot?.rootURI;
  if(!rootURI) throw new Error("PaperPilot 资源尚未加载，请重启 Zotero");
  const {annotations,skipped}=await convertAnnotations(result,ctx);
  if(!annotations.length) throw new Error("没有可可靠定位的引用，未生成空白批注 PDF");
  const dir=PathUtils.join(Zotero.getTempDirectory().path,"paperpilot-"+Zotero.DataObjectUtilities.generateKey());
  await IOUtils.makeDirectory(dir);
  const file=(name:string)=>PathUtils.join(dir,name);
  try {
    // XPI resources are jar: URLs; extract the script only when the export button is used.
    await IOUtils.writeUTF8(file("pdf_annotator.py"),await Zotero.File.getResourceAsync(rootURI+"tools/pdf_annotator.py"));
    const parent=attachment.parentItem || attachment;
    const note=`AI 分析，请核对原文。已定位 ${annotations.length} 条，跳过 ${skipped} 条。`+
      (result.meta?.note || "")+" 点击彩色标记查看批注；蓝色方法、绿色结果、红色局限、橙色建议。";
    const map=buildMindmap(result,"PaperPilot 阅读导图｜"+(parent.getDisplayTitle?.() || "论文")+"｜"+note);
    const png=await svgToPng(map.svg,map.width,map.height);
    if(!png) throw new Error("思维导图图像生成失败，请重试导图按钮");
    const bytes=Uint8Array.from(globalThis.atob(png.split(",")[1]),c=>c.charCodeAt(0));
    await IOUtils.write(file("mindmap.png"),bytes);
    // Export existing library annotations into a temporary copy without modifying the source.
    await Zotero.PDFWorker.export(attachment.id,file("source.pdf"),true,undefined,false);
    await IOUtils.writeJSON(file("request.json"),{annotations,mindmapPath:file("mindmap.png"),guide:note});
    const exitCode=await runPython(binary,["-X","utf8",file("pdf_annotator.py"),file("source.pdf"),file("request.json"),file("output.pdf"),file("report.json")]);
    const report=await IOUtils.exists(file("report.json")) ? await IOUtils.readJSON(file("report.json")) : null;
    if(exitCode !== 0 || !report?.ok) throw new Error(report?.error || "Python 后端未完成。请确认该 Python 已安装 tools/requirements.txt 中的依赖");
    if(report.annotated !== annotations.length || !report.mindmap || !(await IOUtils.exists(file("output.pdf")))) throw new Error("PDF 导出结果不完整");
    const saved=await Zotero.Attachments.importFromFile({file:file("output.pdf"),libraryID:attachment.libraryID,
      parentItemID:parent.isRegularItem?.() ? parent.id : undefined,
      title:`${parent.getDisplayTitle?.() || "论文"} · PaperPilot 增强批注版（含导图）`,contentType:"application/pdf"});
    saved.addTag(EXPORT_TAG);
    await saved.saveTx();
    return {path:await saved.getFilePathAsync(),attachmentID:saved.id,annotated:report.annotated,skipped,layers:report.layers};
  } finally {
    await IOUtils.remove(dir,{recursive:true,ignoreAbsent:true}).catch((e:unknown)=>Zotero.debug("[PaperPilot] 临时目录清理失败："+e));
  }
}
