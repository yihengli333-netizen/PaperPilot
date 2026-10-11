import { allFindings, type SummaryResult } from "./types";
import { locateQuote, type LocateContext } from "./geo";
import { buildMindmap, dataUrlToBytes, svgToPng } from "./mindmap";
import { EXPORT_TAG } from "./pdf-export";
import { writeAnnotatedPDF, type WriterAnnotation } from "./pdf-writer";

export async function convertAnnotations(result:SummaryResult,ctx:LocateContext) {
  const annotations:WriterAnnotation[]=[];
  let skipped=0;
  for(const {cat,finding} of allFindings(result)) {
    if(!finding?.quote) continue;
    if(finding.verified !== true) {skipped++;continue;}
    const loc=await locateQuote(ctx,finding.quote,finding.page || 0);
    if(!loc) {skipped++;continue;}
    annotations.push({category:cat,page:loc.pageIndex,rects:loc.rects,quote:finding.quote,
      summary:"summary" in finding ? finding.summary : finding.description,
      layer:cat === "highlight" ? "L3" : "L2"});
  }
  return {annotations,skipped};
}

/** Enhanced export written in-process with pdf-lib: no Python, no external process. */
export async function annotatePDFAdvanced(attachment:any,result:SummaryResult,ctx:LocateContext) {
  const {annotations,skipped}=await convertAnnotations(result,ctx);
  if(!annotations.length) throw new Error("没有可可靠定位的引用，未生成空白批注 PDF");
  const dir=PathUtils.join(Zotero.getTempDirectory().path,"paperpilot-"+Zotero.DataObjectUtilities.generateKey());
  await IOUtils.makeDirectory(dir);
  const file=(name:string)=>PathUtils.join(dir,name);
  try {
    const parent=attachment.parentItem || attachment;
    const note=`AI 分析，请核对原文。已定位 ${annotations.length} 条，跳过 ${skipped} 条。`+
      (result.meta?.note || "")+" 点击彩色标记查看批注；蓝色方法、绿色结果、红色局限、橙色建议。";
    const map=buildMindmap(result,"PaperPilot 阅读导图｜"+(parent.getDisplayTitle?.() || "论文")+"｜"+note);
    const png=await svgToPng(map.svg,map.width,map.height);
    if(!png) throw new Error("思维导图图像生成失败，请重试导图按钮");
    // Export existing library annotations into a temporary copy without modifying the source.
    await Zotero.PDFWorker.export(attachment.id,file("source.pdf"),true,undefined,false);
    const report=await writeAnnotatedPDF(await IOUtils.read(file("source.pdf")),{annotations,mindmap:dataUrlToBytes(png),guide:note});
    await IOUtils.write(file("output.pdf"),report.bytes);
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
