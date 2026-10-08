import { locateQuote, type LocateContext } from "./geo";
import type { SummaryResult, Finding, Highlight } from "./types";

export const CATEGORY_COLOR: Record<string, string> = {
  research_question: "#ffd400", method: "#2ea8e5", results: "#5fb236",
  limitations: "#ff6666", highlight: "#f19837",
};
export const CATEGORY_LABEL: Record<string, string> = {
  research_question: "研究问题", method: "方法", results: "结果",
  limitations: "疑点/局限", highlight: "建议关注",
};
export const CATEGORY_EMOJI: Record<string, string> = {
  research_question: "🟡", method: "🔵", results: "🟢",
  limitations: "🔴", highlight: "🟠",
};
const MARK_PREFIX = "[PP·";
const OWNER_TAG = "PaperPilot";
const pending = new Map<string, Promise<unknown>>();

export interface AnnotateStats {
  created: number;
  skipped: number;
  existing: number;
  failed: number;
  errors: string[];
}
function owned(item: any): boolean {
  return item?.hasTag?.(OWNER_TAG) === true && item.annotationComment?.startsWith(MARK_PREFIX);
}
function serialize<T>(attachment: any, work: () => Promise<T>): Promise<T> {
  const key = `${attachment.libraryID}:${attachment.id}`;
  const task = (pending.get(key) || Promise.resolve()).catch(()=>{}).then(work);
  pending.set(key,task);
  void task.finally(()=>{if (pending.get(key) === task) pending.delete(key);}).catch(()=>{});
  return task;
}
/** Explicit removal only. A handwritten prefix alone is not proof of ownership. */
export function clearPilotAnnotations(attachment: any): Promise<number> {
  return serialize(attachment,async()=>{
    const list = attachment.getAnnotations().filter(owned);
    let removed = 0;
    for (const item of list) { await item.eraseTx(); removed++; }
    return removed;
  });
}

/** Add verified highlights; retain existing annotations, including edited comments. */
export function annotatePDF(attachment: any, result: SummaryResult, ctx: LocateContext): Promise<AnnotateStats> {
  return serialize(attachment,async()=>{
    const stats: AnnotateStats = {created:0,skipped:0,existing:0,failed:0,errors:[]};
    const tasks: Array<{cat:string; finding:Finding | Highlight}> = [];
    for (const cat of ["research_question","method","results","limitations"] as const) {
      if (result[cat]?.quote) tasks.push({cat,finding:result[cat]});
    }
    for (const finding of result.highlights || []) if (finding.quote) tasks.push({cat:"highlight",finding});
    for (const {cat,finding:f} of tasks) {
      if (f.verified !== true) {
        stats.skipped++; continue;
      }
      const loc = await locateQuote(ctx,f.quote,f.page || 0);
      if (!loc) { stats.skipped++; continue; }
      const position = {pageIndex:loc.pageIndex,rects:loc.rects};
      const color = CATEGORY_COLOR[cat];
      const duplicate = attachment.getAnnotations().some((a:any)=> {
        if (!owned(a) || a.annotationText !== f.quote || a.annotationColor !== color) return false;
        try { return JSON.stringify(JSON.parse(a.annotationPosition)) === JSON.stringify(position); }
        catch { return false; }
      });
      if (duplicate) { stats.existing++; continue; }
      try {
        await Zotero.Annotations.saveFromJSON(attachment,{
          key:Zotero.DataObjectUtilities.generateKey(),type:"highlight",color,
          sortIndex:loc.sortIndex,position,text:f.quote,
          comment:`${MARK_PREFIX}${CATEGORY_EMOJI[cat]} ${CATEGORY_LABEL[cat]}] ${"summary" in f ? f.summary : f.description}`,
          pageLabel:String(loc.pageIndex+1),tags:[{name:OWNER_TAG}],
        });
        stats.created++;
      } catch(e) {
        stats.failed++;
        const message = e instanceof Error ? e.message : String(e);
        stats.errors.push(message);
        Zotero.debug("[PaperPilot] 高亮保存失败: "+message);
      }
    }
    return stats;
  });
}
