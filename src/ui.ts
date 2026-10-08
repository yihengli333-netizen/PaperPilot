import { analyzeItem, findPDFAttachment, toMarkdown } from "./analyze";
import { annotatePDF, clearPilotAnnotations, CATEGORY_COLOR, CATEGORY_LABEL } from "./annotate";
import { buildMindmap, saveMindmap, getMindmapAttachments } from "./mindmap";
import { buildGuideNote } from "./note";
import { copyToClipboard, gotoLocation, toast, ensureReader } from "./nav";
import { getCache, makeKey } from "./store";
import { isConfigured } from "./prefs";
import { exportAnnotatedPDF } from "./pdf-export";
import { annotatePDFAdvanced } from "./python_bridge";
import { ADDON_ID } from "./types";
import type { SummaryResult } from "./types";

const operationState = new Map<number,{message:string; pdfID?:number;path?:string;svg?:string;busy?:boolean}>();
const stateKey = (item:any)=>item.parentItem?.id || item.id;
function showStatus(container:HTMLElement,item:any,message?:string) {
  const key=stateKey(item);
  const state=operationState.get(key) || {message:""};
  if(message !== undefined) {state.message=message;operationState.set(key,state);}
  let box=container.querySelector('.pp-status') as HTMLElement;
  if(!box) {box=container.ownerDocument.createElementNS('http://www.w3.org/1999/xhtml','div');box.className='pp-status';container.appendChild(box);}
  box.replaceChildren();box.setAttribute('role','status');box.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;margin-top:8px';
  const line=container.ownerDocument.createElementNS('http://www.w3.org/1999/xhtml','p');line.textContent=state.message;box.appendChild(line);
  if(state.pdfID) {
    const open=button(container.ownerDocument,'打开批注 PDF','open-output');
    open.addEventListener('click',()=>Zotero.Reader.open(state.pdfID));box.appendChild(open);
  }
  if(state.path) {
    const reveal=button(container.ownerDocument,'打开文件所在文件夹','reveal-output');
    reveal.addEventListener('click',()=>Zotero.File.reveal(state.path));box.appendChild(reveal);
  }
  if(state.svg) {
    const img=container.ownerDocument.createElementNS('http://www.w3.org/1999/xhtml','img');
    img.setAttribute('src','data:image/svg+xml;charset=utf-8,'+encodeURIComponent(state.svg));
    img.setAttribute('alt','PaperPilot 思维导图预览');img.style.cssText='display:block;width:100%;margin-top:8px';box.appendChild(img);
  }
}


function esc(s: any): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STYLE = `
<style>
.pp-wrap{font-size:12px;line-height:1.6;padding:2px 0}
.pp-item{margin:0 0 10px}
.pp-label{font-weight:600;color:#2f6fb3;margin:0 0 2px}
.pp-text{margin:0 0 3px;white-space:pre-wrap;word-break:break-word}
.pp-meta{color:#777;font-size:11px;word-break:break-word}
.pp-link{color:#2f6fb3;cursor:pointer;text-decoration:underline;margin-right:8px}
.pp-link:hover{color:#134a80}
.pp-flag{color:#b35900}
.pp-hl{border-left:3px solid #d9e6f2;padding:4px 0 4px 8px;margin:0 0 8px}
.pp-hl-title{font-weight:600}
.pp-actions{margin-top:8px;display:flex;flex-wrap:wrap;gap:6px}
.pp-btn{font-size:11px;padding:2px 8px;cursor:pointer}
.pp-note{background:#fffbe6;border:1px solid #ffe58f;padding:6px 8px;border-radius:3px;margin:8px 0;color:#8a6d00}
.pp-empty{color:#888;font-style:italic}
.pp-quote{color:#555;font-style:italic}
.pp-legend{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 10px}
.pp-lg{display:inline-flex;align-items:center;font-size:11px;color:#444}
.pp-lg i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:4px}
.pp-idx{margin:6px 0 10px}
.pp-idx-cat{font-size:11px;font-weight:600;margin:8px 0 3px;display:flex;align-items:center}
.pp-idx-cat i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:5px}
.pp-idx-item{display:flex;justify-content:space-between;gap:6px;padding:2px 2px 2px 16px;cursor:pointer;border-radius:3px;font-size:11px}
.pp-idx-item:hover{background:#f2f6fb}
.pp-idx-item .pp-idx-title{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pp-idx-item .pp-idx-page{color:#999;flex:none}
</style>`;

function html(container: HTMLElement, markup: string) {
  const doc = container.ownerDocument;
  const root = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  root.innerHTML = markup;
  container.replaceChildren(root);
}

function button(doc: any, text: string, action: string) {
  const el = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
  el.className = "pp-btn";
  el.textContent = text;
  el.dataset.ppAct = action;
  return el;
}

function addButtons(container: HTMLElement, actions: Array<[string,string]>) {
  const root: any = container.firstElementChild || container;
  let actionsEl = root.querySelector(".pp-actions");
  if (!actionsEl) {
    actionsEl = root.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "div");
    actionsEl.className = "pp-actions";
    root.appendChild(actionsEl);
  }
  actionsEl.replaceChildren(...actions.map(([text,action])=>button(root.ownerDocument,text,action)));
}

function addResultButtons(container: HTMLElement) {
  addButtons(container, [
    ["📄 导出带批注 PDF", "exportPDF"], ["🖍️ 在 Zotero 中标注", "highlight"], ["🧹 清除本插件批注", "clearHl"],
    ["🗺️ 思维导图", "mindmap"], ["💾 保存导读", "save"],
    ["📋 复制MD", "copy"], ["📑 导出增强批注 PDF（含导图）", "advancedAnnotate"], ["🔄 重新分析", "reload"],
  ]);
}

function findingHTML(label: string, f: any): string {
  if (!f || (!f.summary && !f.quote)) {
    return `<div class="pp-item"><div class="pp-label">${esc(label)}</div><div class="pp-empty">未在正文中找到</div></div>`;
  }
  const badge = f.verified ? "" : ' <span class="pp-flag">⚠️片段未校验</span>';
  const jump =
    f.page || f.quote
      ? `<span class="pp-link" data-pp-jump="1" data-page="${f.page || 0}" data-quote="${esc(
          (f.quote || "").slice(0, 160)
        )}">📍 ${esc(f.location || "跳转")}</span>`
      : "";
  return `<div class="pp-item">
    <div class="pp-label">${esc(label)}${badge}</div>
    <div class="pp-text">${esc(f.summary)}</div>
    <div class="pp-meta">${jump}${f.quote ? `<span class="pp-quote">“${esc(f.quote.slice(0, 80))}”</span>` : ""}</div>
  </div>`;
}

function legendHTML(): string {
  const items = Object.entries(CATEGORY_LABEL)
    .map(([k, v]) => {
      const c = CATEGORY_COLOR[k];
      return `<span class="pp-lg"><i style="background:${c}"></i>${esc(v)}</span>`;
    })
    .join("");
  return `<div class="pp-legend">${items}</div>`;
}

/** 分组索引：按类别列出，点击跳转 */
function indexHTML(result: SummaryResult): string {
  const group = (cat: string, items: any[]): string => {
    if (!items.length) return "";
    const c = CATEGORY_COLOR[cat];
    const rows = items
      .map((f: any) => {
        const title = f.title || f.summary || CATEGORY_LABEL[cat];
        const page = f.page ? `p.${f.page}` : "";
        return `<div class="pp-idx-item" data-pp-jump="1" data-page="${f.page || 0}" data-quote="${esc(
          (f.quote || "").slice(0, 160)
        )}" title="${esc(f.summary || f.description || "")}">
          <span class="pp-idx-title">${esc(title)}</span><span class="pp-idx-page">${page}</span>
        </div>`;
      })
      .join("");
    return `<div class="pp-idx-cat"><i style="background:${c}"></i>${esc(CATEGORY_LABEL[cat])}</div>${rows}`;
  };
  const parts = [
    group("research_question", result.research_question?.summary ? [result.research_question] : []),
    group("method", result.method?.summary ? [result.method] : []),
    group("results", result.results?.summary ? [result.results] : []),
    group("limitations", result.limitations?.summary ? [result.limitations] : []),
    group("highlight", result.highlights || []),
  ].filter(Boolean);
  if (!parts.length) return "";
  return `<div class="pp-idx"><div class="pp-label" style="margin:0 0 2px">🗂️ 导读索引（点击跳转）</div>${parts.join("")}</div>`;
}

function summaryHTML(result: SummaryResult, fromCache: boolean): string {
  const hs = (result.highlights || [])
    .map((h) => {
      const badge = h.verified ? "" : ' <span class="pp-flag">⚠️</span>';
      const jump =
        h.page || h.quote
          ? `<span class="pp-link" data-pp-jump="1" data-page="${h.page || 0}" data-quote="${esc(
              (h.quote || "").slice(0, 160)
            )}">📍 ${esc(h.location || "跳转")}</span>`
          : "";
      return `<div class="pp-hl">
        <div class="pp-hl-title">${esc(h.title)}${badge}</div>
        <div class="pp-text">${esc(h.description)}</div>
        <div class="pp-meta">${jump}</div>
      </div>`;
    })
    .join("");

  const note = result.meta?.note
    ? `<div class="pp-note">${esc(result.meta.note)}</div>`
    : "";
  const unverified = [
    result.research_question,
    result.method,
    result.results,
    result.limitations,
    ...(result.highlights || []),
  ].filter((f: any) => f && !f.verified).length;
  const warn =
    unverified > 0
      ? `<div class="pp-note">有 ${unverified} 条引用片段未在原文中匹配到（已标 ⚠️），请点击 📍 自行核对。</div>`
      : "";

  return `${STYLE}<div class="pp-wrap">
    ${note}${warn}
    ${legendHTML()}
    ${indexHTML(result)}
    ${findingHTML("🎯 研究问题", result.research_question)}
    ${findingHTML("🔬 核心方法", result.method)}
    ${findingHTML("📊 主要结果", result.results)}
    ${findingHTML("⚠️ 作者承认的局限", result.limitations)}
    <div class="pp-label" style="margin-top:10px">📌 建议重点关注</div>
    ${hs || '<div class="pp-empty">无</div>'}
    <div class="pp-actions"></div>
    <div class="pp-meta" style="margin-top:6px">${
      fromCache ? "来自缓存 · " : ""
    }${esc(result.meta?.model || "")}</div>
  </div>`;
}

async function runAnalyze(container: HTMLElement, item: any, force: boolean, auto: boolean) {
  if (!isConfigured()) {
    html(container, `${STYLE}<div class="pp-wrap"><div class="pp-note">尚未配置模型服务。请在 Zotero 设置 → PaperPilot 中填写 API 端点、密钥与模型。</div></div>`);
    addButtons(container, [["模型设置", "settings"], ["重试", "reload"]]);
    bind(container, item, null);
    return;
  }
  html(container, `${STYLE}<div class="pp-wrap"><div class="pp-empty">正在分析论文…（首次约需 10-60 秒）</div></div>`);
  try {
    const { result, fromCache } = await analyzeItem(item, { force });
    if (!container.isConnected) return;
    html(container, summaryHTML(result, fromCache));
    addResultButtons(container);
    bind(container, item, result);
  } catch (e: any) {
    html(container, `${STYLE}<div class="pp-wrap">
      <div class="pp-note">分析失败：${esc(e?.message || e)}</div>
      <div class="pp-actions"></div>
    </div>`);
    addButtons(container, [["重试", "reload"]]);
    bind(container, item, null);
    if (auto) toast("PaperPilot", "分析失败：" + (e?.message || e));
  }
}

async function doHighlight(item: any, result: SummaryResult): Promise<string> {
  const att = findPDFAttachment(item);
  if (!att) {
    throw new Error("未找到 PDF 附件");
  }
  toast("PaperPilot", "正在写入 PDF 高亮与批注…");
  const reader = await ensureReader(att.id);
  const stats = await annotatePDF(att, result, {
    reader,
  });
  return `新增 ${stats.created} 条高亮，已有 ${stats.existing} 条。`
      + (stats.skipped ? `${stats.skipped} 条未通过引用校验或未找到唯一坐标，可点击 📍 搜索核对。` : "")
      + (stats.failed ? `${stats.failed} 条保存失败：${stats.errors[0]}。旧高亮已保留。` : "")
      + "\n分享文件请点击“导出带批注 PDF”。";
}

async function doClearHighlight(item: any) {
  const att = findPDFAttachment(item);
  if (!att) {
    toast("PaperPilot", "未找到 PDF 附件");
    return;
  }
  const n = await clearPilotAnnotations(att);
  toast("PaperPilot", `已清除 ${n} 条 PaperPilot 高亮`);
  return n;
}

async function doMindmap(item: any, result: SummaryResult) {
  const title = item.getDisplayTitle ? item.getDisplayTitle() : "论文";
  toast("PaperPilot", "正在生成思维导图…");
  const out = buildMindmap(result, title);
  const res = await saveMindmap(item, out);
  if (!res.svgSaved && !res.pngSaved) throw new Error("思维导图附件保存失败："+res.errors.join("；"));
  toast(
    "PaperPilot",
    `思维导图已生成：SVG ${res.svgSaved ? "✓" : "✗"} · PNG ${res.pngSaved ? "✓" : "✗"}（见本条目附件）`
  );
  return {out,res};
}

async function doAdvancedAnnotate(item: any, result: SummaryResult) {
  const att = findPDFAttachment(item);
  if (!att) {
    throw new Error("未找到 PDF 附件");
  }
  
  toast("PaperPilot", "正在定位引用并生成带导图的 PDF 副本…");
  
  // 打开 PDF 获取坐标上下文
  const reader = await ensureReader(att.id);
  const ctx = { reader };
  
  return annotatePDFAdvanced(att, result, ctx);
}

export async function saveGuideNote(item: any, result: SummaryResult) {
  const title = item.getDisplayTitle ? item.getDisplayTitle() : "论文";
  const attachments = getMindmapAttachments(item);
  const html = buildGuideNote(result, title, { mindmapSaved: attachments.length > 0, attachments });
  try {
    const parent = item.isAttachment && item.isAttachment() ? item.parentItem || item : item;
    const note = new Zotero.Item("note");
    note.libraryID = parent.libraryID;
    if (parent.isRegularItem && parent.isRegularItem()) note.parentID = parent.id;
    note.setNote(html);
    await note.saveTx();
    toast("PaperPilot", "导读已保存为条目笔记");
  } catch (e: any) {
    throw new Error("保存失败：" + (e?.message || e));
  }
}

function bind(container: HTMLElement, item: any, result: SummaryResult | null) {
  container.querySelectorAll("[data-pp-jump]").forEach((el) => {
    el.addEventListener("click", async () => {
      const att = findPDFAttachment(item);
      if (!att) {
        toast("PaperPilot", "未找到 PDF 附件");
        return;
      }
      const page = Number((el as HTMLElement).dataset.page || 0);
      const quote = (el as HTMLElement).dataset.quote || "";
      await gotoLocation({ itemID: att.id, page, quote, location: "" });
    });
  });

  container.querySelectorAll("[data-pp-act]").forEach((el) => {
    el.addEventListener("click", async () => {
      const act = (el as HTMLElement).dataset.ppAct;
      if (act === "settings") { Zotero.PaperPilot.openSettings(); return; }
      if (act === "reload" || act === "generate") {
        await runAnalyze(container, item, act === "reload", false);
        return;
      }
      if (!result) return;
      const key=stateKey(item);
      if(operationState.get(key)?.busy) return;
      operationState.set(key,{...operationState.get(key),message:"正在处理，请稍候…",busy:true});
      showStatus(container,item);
      try {
        if (act === "highlight") {
          showStatus(container,item,await doHighlight(item, result));
        } else if (act === "advancedAnnotate") {
          const output=await doAdvancedAnnotate(item, result);
          operationState.set(key,{message:`增强批注 PDF 已生成：${output.layers.L2} 条句子高亮、${output.layers.L3} 条建议片段下划线，均带分析批注。\n已附阅读导图和书签；${output.skipped} 条未可靠定位，已跳过。原始 PDF 保留。\n文件：${output.path}`,pdfID:output.attachmentID,path:output.path});
          showStatus(container,item);
        } else if (act === "exportPDF") {
          const output=await exportAnnotatedPDF(item,result);
          operationState.set(key,{message:`批注 PDF 已生成，包含 ${output.stats.created+output.stats.existing} 条高亮和中文分析批注。\n${output.stats.skipped} 条未可靠定位，未强行标注。\n文件：${output.path}`,pdfID:output.attachmentID,path:output.path});
          showStatus(container,item);
          toast("PaperPilot","批注 PDF 已保存到本论文的附件中");
        } else if (act === "clearHl") {
          const n=await doClearHighlight(item);
          showStatus(container,item,`已清除 ${n || 0} 条 PaperPilot 批注。之前导出的 PDF 副本保持不变。`);
        } else if (act === "mindmap") {
          const {out,res}=await doMindmap(item,result);
          operationState.set(key,{message:`思维导图已生成：SVG ${res.svgSaved ? "✓":"✗"} · PNG ${res.pngSaved ? "✓":"✗"}。\n见下方预览与本条目附件。`+(res.errors.length ? "\n"+res.errors.join("；"):""),svg:out.svg,path:res.paths.at(-1)});
          showStatus(container,item);
        } else if (act === "save") {
          await saveGuideNote(item, result);
          showStatus(container,item,"导读已保存为本论文的子笔记。");
        } else if (act === "copy") {
          const md = toMarkdown(result, item.getDisplayTitle ? item.getDisplayTitle() : "论文");
          copyToClipboard(md);
          toast("PaperPilot", "已复制 Markdown 到剪贴板");
          showStatus(container,item,"已复制 Markdown 到剪贴板。");
        }
      } catch (e: any) {
        showStatus(container,item,"操作失败："+(e?.message || e));
        toast("PaperPilot", "操作失败：" + (e?.message || e));
      } finally {
        const state=operationState.get(key);if(state) state.busy=false;
      }
    });
  });
}

/** 注册条目面板分区 */
let sectionID: string | false;
export function unregisterSection() { if (sectionID) Zotero.ItemPaneManager.unregisterSection(sectionID); }
export function registerSection(): void {
  if (!Zotero.ItemPaneManager) throw new Error("PaperPilot：当前 Zotero 不支持条目面板接口");
  const icon = Zotero.PaperPilot?.rootURI
    ? Zotero.PaperPilot.rootURI + "chrome/skin/icon.svg"
    : "chrome://zotero/skin/16/universal/document.svg";

  sectionID = Zotero.ItemPaneManager.registerSection({
    paneID: "paperpilot-summary",
    pluginID: ADDON_ID,
    header: {
      l10nID: "paperpilot-section-header",
      icon,
    },
    sidenav: { l10nID: "paperpilot-section-sidenav", icon },
    sectionButtons: [
      {
        type: "refresh",
        icon: "chrome://zotero/skin/16/universal/refresh@2x.png",
        l10nID: "paperpilot-refresh",
        onClick: async ({ item, body }: any) => {
          await runAnalyze(
            body.querySelector(".pp-container") as HTMLElement,
            item,
            true,
            false
          );

        },
      },
    ],
    onItemChange: ({ item, setEnabled, setSectionSummary }: any) => {
      const has = !!findPDFAttachment(item);
      setEnabled(has);
      setSectionSummary(has ? "" : "无 PDF 附件");
    },
    onInit: ({ doc }: any) => {
      doc.defaultView?.MozXULElement?.insertFTLIfNeeded("paperpilot.ftl");
    },
    onRender: ({ item, body, doc }: any) => {
      const container = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      container.id = `pp-pane-${item.key}`;
      container.className = "pp-container";
      body.replaceChildren(container);
      html(container, `${STYLE}<p>选好论文后，点击下面的按钮。</p><div class="pp-actions"></div>`);
      addButtons(container, [["生成总结", "generate"], ["模型设置", "settings"]]);
      bind(container, item, null);
      showStatus(container,item);
    },
    onAsyncRender: async ({ item, body }: any) => {
      const container = body.querySelector(".pp-container");
      const att = findPDFAttachment(item);
      if (!att || !container) return;
      const cached = await getCache(await makeKey(att));
      if (!container.isConnected) return;
      if (cached) {
        html(container, summaryHTML(cached, true));
        addResultButtons(container);
        bind(container,item,cached);
        showStatus(container,item);
      }
      else if (Zotero.Prefs.get("extensions.zotero.paperpilot.autoAnalyze",true) === true) await runAnalyze(container,item,false,true);
    },
    onDestroy: () => {},
  });
  if (!sectionID) throw new Error("PaperPilot：条目面板注册失败，请查看 Zotero 错误报告");
}

/** 快捷键/菜单：分析当前选中条目 */
export async function analyzeSelected(): Promise<void> {
  const win = Zotero.getMainWindow();
  const items = win?.ZoteroPane?.getSelectedItems() || [];
  if (!items.length) {
    toast("PaperPilot", "请先选中一个条目");
    return;
  }
  let ok = 0;
  const failures: string[] = [];
  const unique = [...new Map(items.map((i:any)=>{const parent=i.parentItem || i;return [parent.id,parent];})).values()] as any[];
  for (const item of unique) {
    try {
      const {result} = await analyzeItem(item);
      await saveGuideNote(item, result);
      ok++;
    } catch(e:any) { failures.push(`${item.getDisplayTitle?.() || "条目"}：${e.message}`); }
  }
  toast("PaperPilot", `已保存 ${ok} 篇` + (failures.length ? `；失败 ${failures.length} 篇：${failures.join("；")}` : ""));

}

export { runAnalyze };
