/**
 * 详尽导读笔记：层级大纲 + 颜色图例 + 分组索引 + 思维导图指引。
 * 输出为 HTML（直接写入 Zotero 笔记），保留用户书写区。
 */
import { CATEGORY_COLOR, CATEGORY_LABEL } from "./annotate";
import type { SummaryResult } from "./types";
import type { MindmapAttachment } from "./mindmap";

function esc(s: any): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function chip(cat: string): string {
  const c = CATEGORY_COLOR[cat] || "#888";
  return `<span style="display:inline-block;padding:1px 8px;border-radius:10px;background:${c}22;border:1px solid ${c};color:#333;font-size:11px">${esc(CATEGORY_LABEL[cat] || cat)}</span>`;
}

function loc(f: any): string {
  const p = f.page ? `第 ${f.page} 页` : (f.location || "未标注页码");
  const q = f.quote ? `“${esc(String(f.quote).slice(0, 120))}”` : "无原文片段";
  return `<div style="color:#777;font-size:11px;margin:2px 0 0">📍 ${esc(p)} ｜ 原文：${q}${f.verified === false ? ' <span style="color:#b35900">⚠️未校验</span>' : ""}</div>`;
}

function section(num: number, cat: string, f: any, extra = ""): string {
  if (!f || !f.summary) return "";
  return `<div style="margin:0 0 14px">
  <div style="font-weight:600;margin:0 0 4px">${num}. ${chip(cat)} ${esc(extra || CATEGORY_LABEL[cat])}</div>
  <div style="margin:0 0 2px">${esc(f.summary)}</div>
  ${loc(f)}
</div>`;
}

/** 生成导读 HTML */
export function buildGuideNote(result: SummaryResult, title: string, opts: { mindmapSaved?: boolean; attachments?: MindmapAttachment[] } = {}): string {
  const legend = Object.entries(CATEGORY_LABEL)
    .map(([k, v]) => {
      const c = CATEGORY_COLOR[k];
      return `<span style="display:inline-flex;align-items:center;margin-right:12px"><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${c};margin-right:4px"></span>${esc(v)}</span>`;
    })
    .join("");

  const outline: string[] = [];
  let n = 1;
  if (result.research_question?.summary) outline.push(section(n++, "research_question", result.research_question, "研究问题"));
  if (result.method?.summary) outline.push(section(n++, "method", result.method, "核心方法"));
  if (result.results?.summary) outline.push(section(n++, "results", result.results, "主要结果"));
  if (result.limitations?.summary) outline.push(section(n++, "limitations", result.limitations, "作者承认的局限"));

  const hl = (result.highlights || [])
    .map((h: any, i: number) => {
      return `<div style="margin:0 0 12px">
      <div style="font-weight:600">${i + 1}. ${chip("highlight")} ${esc(h.title)}</div>
      <div>${esc(h.description)}</div>
      ${loc(h)}
    </div>`;
    })
    .join("");

  const mindmapBlock = `
  <div style="margin:0 0 14px;padding:10px 12px;background:#f6f9fd;border:1px solid #d9e6f2;border-radius:6px">
    <div style="font-weight:600;margin:0 0 4px">🗺️ 思维导图</div>
    <div style="color:#555;font-size:12px">${
      opts.mindmapSaved
        ? "已生成并保存为本条目附件。" + (opts.attachments || []).map(a=>`<p><a href="${esc(a.url)}">${esc(a.title)}</a></p>`).join("")
        : "尚未生成。在条目面板点击 <strong>🗺️ 思维导图</strong> 即可生成 SVG 与 PNG 附件。"
    }</div>
  </div>`;

  return `<h1>📄 ${esc(title)} · PaperPilot 导读</h1>
<p style="color:#777;font-size:12px">生成于 ${new Date(result.meta?.createdAt || Date.now()).toLocaleString("zh-CN")}${
    result.meta?.model ? " · 模型 " + esc(result.meta.model) : ""
  }</p>
<div style="margin:0 0 12px;padding:8px 10px;background:#fafafa;border:1px solid #eee;border-radius:6px;font-size:12px"><strong>颜色图例</strong>（PDF 高亮与导读一致）：<div style="margin-top:4px">${legend}</div></div>
${mindmapBlock}
<h2>📖 文章脉络大纲</h2>
${outline.join("\n") || "<p><em>未能提取大纲。</em></p>"}
<h2>📌 建议重点关注</h2>
${hl || "<p><em>无</em></p>"}
${result.meta?.note ? `<blockquote style="color:#8a6d00;border-left:3px solid #ffe58f;margin:12px 0;padding:4px 10px;background:#fffbe6">说明：${esc(result.meta.note)}</blockquote>` : ""}
<hr/>
<h2>✍️ 我的理解与疑问</h2>
<p>&nbsp;</p>
<p>&nbsp;</p>`;
}
