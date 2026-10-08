import {findPDFAttachment} from "./analyze";
import {annotatePDF, type AnnotateStats} from "./annotate";
import {ensureReader} from "./nav";
import type {SummaryResult} from "./types";

export const EXPORT_TAG = "PaperPilot Export";
const GUIDE_PREFIX = "[PP·阅读指引]";

function guideText(result: SummaryResult, stats: AnnotateStats): string {
  return `${GUIDE_PREFIX}\n本文件已嵌入彩色高亮和中文分析批注，可在支持 PDF 批注的阅读器中查看、分享。\n`
    + "阅读顺序：先看蓝色的方法，再看绿色结果，最后核对红色局限与橙色建议。黄色表示研究问题。点击高亮查看对应分析。\n"
    + `本次定位 ${stats.created+stats.existing} 条；未可靠定位 ${stats.skipped} 条；保存失败 ${stats.failed} 条。未可靠定位的内容没有强行标注。\n`
    + "分析由 AI 生成，不等于作者原话；请结合高亮原文核对。\n"
    + (result.meta?.note ? `分析范围：${result.meta.note}\n` : "")
    + [
      ["研究问题",result.research_question], ["方法",result.method],
      ["结果",result.results], ["作者局限",result.limitations],
    ].filter(([,f])=>typeof f === "object" && f?.summary).map(([label,f]:any)=>
      `\n${label}${f.verified ? "" : "（原文片段未校验）"}：${f.summary}`
    ).join("");
}

export interface PDFExportResult { path: string; attachmentID: number; stats: AnnotateStats; annotationCount: number }

/** Export a separate PDF through Zotero's own writer, preserving original files and library annotations. */
export async function exportAnnotatedPDF(item: any, result: SummaryResult, outputPath?: string): Promise<PDFExportResult> {
  const att = findPDFAttachment(item);
  if (!att) throw new Error("未找到原始 PDF 附件");
  const source = await att.getFilePathAsync();
  if (!source) throw new Error("原始 PDF 文件不存在，请先下载附件");
  if (outputPath) {
    const normalized = (p:string)=>p.replace(/\\/g,"/").toLowerCase();
    if (normalized(source) === normalized(outputPath)) throw new Error("请另存为新文件，不能覆盖原始 PDF");
    if (await IOUtils.exists(outputPath)) throw new Error("目标文件已经存在，请使用新文件名");
  }
  const reader = await ensureReader(att.id);
  const stats = await annotatePDF(att,result,{reader});
  if (!stats.created && !stats.existing) throw new Error("没有可可靠定位的高亮，未导出空白批注版。请先核对原文片段或重新分析。");
  const comment = guideText(result,stats);
  const existing = att.getAnnotations().some((a:any)=>a.hasTag?.("PaperPilot") && a.annotationComment === comment);
  if (!existing) {
    await Zotero.Annotations.saveFromJSON(att,{
      key:Zotero.DataObjectUtilities.generateKey(),type:"note",color:"#ffd400",text:"",comment,
      pageLabel:"1",sortIndex:"00000|000000|00000",
      position:{pageIndex:0,rects:[[20,20,42,42]]},tags:[{name:"PaperPilot"}],
    });
  }
  const parent = att.parentItem || item;
  const token = Zotero.DataObjectUtilities.generateKey();
  const path = outputPath || PathUtils.join(Zotero.getTempDirectory().path,`PaperPilot-annotated-${token}.pdf`);
  let written = false;
  try {
    const annotationCount = await Zotero.PDFWorker.export(att.id,path,true,undefined,false);
    written = true;
    if (!annotationCount || !(await IOUtils.exists(path))) throw new Error("PDF 批注写入未完成，请检查文件权限");
    const attachment = await Zotero.Attachments.importFromFile({
      file:path,libraryID:att.libraryID,parentItemID:parent.isRegularItem?.() ? parent.id : undefined,
      title:`${parent.getDisplayTitle?.() || "论文"} · PaperPilot 高亮批注版`,contentType:"application/pdf",
    });
    attachment.addTag(EXPORT_TAG);
    await attachment.saveTx();
    return {path:outputPath || await attachment.getFilePathAsync(),attachmentID:attachment.id,stats,annotationCount};
  } catch(e) {
    if (written && outputPath) throw new Error(`PDF 已保存到 ${outputPath}，但加入文库失败：${String(e)}`);
    throw e;
  } finally {
    if (!outputPath) await IOUtils.remove(path,{ignoreAbsent:true}).catch((e:unknown)=>Zotero.debug("[PaperPilot] 导出临时文件清理失败："+e));
  }
}
