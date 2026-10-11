import { callLLM, condenseText, normalizeResult, LLMError } from "./llm";
import { parseItem, parsePage, verifyQuote } from "./parser";
import { getConfig } from "./prefs";
import { getCache, makeKey, setCache } from "./store";
import { matchQuote } from "./text";
import { allFindings, type PageText, type SummaryResult } from "./types";

export interface AnalyzeOptions {
  force?: boolean;
  onProgress?: (msg: string) => void;
}

/** 找到条目下可用的 PDF 附件 */
export function findPDFAttachment(item: any): any {
  try {
    if (item.isAttachment && item.isAttachment()) {
      const ct = item.attachmentContentType || "";
      if (/pdf/i.test(ct) && !item.hasTag?.("PaperPilot Export")) return item;
      if (item.hasTag?.("PaperPilot Export") && item.parentItem) return findPDFAttachment(item.parentItem);
      return null;
    }
    const ids: number[] = item.getAttachments ? item.getAttachments() : [];
    for (const id of ids) {
      const att = Zotero.Items.get(id);
      if (att && !att.deleted && !att.hasTag?.("PaperPilot Export") && /pdf/i.test(att.attachmentContentType || "")) return att;
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

const SECTION_NAMES: Record<string, string> = {
  references: "参考文献", acknowledgements: "致谢", appendix: "附录",
};

/**
 * 校验所有引用片段并解析页码。模型改动了个别字词的引用经模糊匹配后替换为原文片段（corrected），
 * 之后的定位与高亮都基于原文，而不是模型的措辞。
 */
export function postProcess(result: SummaryResult, fullText: string, pages?: PageText[]): SummaryResult {
  for (const { finding: f } of allFindings(result)) {
    const match = f.quote ? matchQuote(fullText, f.quote) : null;
    // 跨页的片段带有页码标记，不是连续原文
    const valid = match && !/\[PDF Page \d+\]/.test(match.text) ? match : null;
    f.verified = !!valid;
    if (valid && !valid.exact) {
      f.quote = valid.text;
      f.corrected = true;
    }
    f.page = parsePage(f.location);
    if (pages && f.verified) {
      const hits = pages.filter((p) => verifyQuote(p.text, f.quote));
      f.page = hits.length === 1 ? hits[0].index + 1 : 0;
      if (f.page) f.location = `PDF 第 ${f.page} 页`;
    }
  }
  return result;
}

export async function analyzeItem(
  item: any,
  opts: AnalyzeOptions = {}
): Promise<{ result: SummaryResult; fromCache: boolean }> {
  const cfg = getConfig();
  if (!cfg.apiKey) {
    throw new LLMError("尚未配置 API 密钥，请在 PaperPilot 设置中填写。", "config");
  }

  const attachment = findPDFAttachment(item);
  if (!attachment) {
    throw new LLMError("该条目没有 PDF 附件。", "no-attachment");
  }

  const key = await makeKey(attachment, cfg);
  if (!opts.force) {
    const cached = await getCache(key);
    if (cached) return { result: cached, fromCache: true };
  }

  opts.onProgress?.("正在提取 PDF 文本…");
  const doc = await parseItem(attachment);

  const { text: body, partial, omitted } = condenseText(doc.fullText, cfg.maxInputChars);

  opts.onProgress?.("正在调用模型生成总结…");
  const raw = await callLLM(cfg, doc.metaText, body, cfg.highlightCount, opts.onProgress);

  const result = postProcess(normalizeResult(raw, cfg.model), doc.fullText, doc.hasPageInfo ? doc.pages : undefined);
  const findings = allFindings(result).filter(({ finding }) => finding.quote);
  const corrected = findings.filter(({ finding }) => finding.corrected).length;
  result.meta = {
    model: cfg.model,
    createdAt: Date.now(),
    language: cfg.language,
    coverage: doc.coverage === "full" && !partial ? "full" : "partial",
    note: [
      omitted.length ? `未发送${omitted.map((k) => SECTION_NAMES[k] || k).join("、")}` : "",
      partial ? "论文较长，部分章节只发送了开头（建议核对结论）" : "",
      corrected ? `${corrected} 条引用与原文有个别字词差异，已替换为原文片段` : "",
      doc.hasPageInfo ? "页码依据原文片段逐页匹配；无法唯一匹配时请用搜索核对" : "未能获取逐页信息，模型页码未经校验，请用原文搜索核对",
    ]
      .filter(Boolean)
      .join("；"),
  };

  await setCache(key, attachment.getField?.("title") || "", cfg.model, result);
  return {
    result,
    fromCache: false,
  };
}

/** 把结果渲染为 Markdown（用于保存到笔记） */
export function toMarkdown(result: SummaryResult, title: string): string {
  const line = (label: string, f: any) => {
    const flag = f.verified ? "" : " ⚠️未校验";
    const extra = (f.evidence || []).map((e: any) =>
      `\n   - 补充：${e.summary}${e.verified ? "" : " ⚠️未校验"}（${e.location || "未标注"}）“${e.quote}”`).join("");
    return `**${label}**：${f.summary}${flag}\n   - 位置：${f.location || "未标注"}\n   - 原文：${f.quote ? "“" + f.quote + "”" : "无"}${extra}`;
  };
  const parts: string[] = [
    `# ${title}`,
    "",
    `*由 PaperPilot 生成于 ${new Date(result.meta?.createdAt || Date.now()).toLocaleString("zh-CN")}${
      result.meta?.model ? " · 模型 " + result.meta.model : ""
    }*`,
    "",
    line("研究问题", result.research_question),
    "",
    line("核心方法", result.method),
    "",
    line("主要结果", result.results),
    "",
    line("作者承认的局限", result.limitations),
    "",
    "## 建议重点关注",
    "",
  ];
  (result.highlights || []).forEach((h, i) => {
    parts.push(
      `${i + 1}. **${h.title}**${h.verified ? "" : " ⚠️未校验"}  \n   ${h.description}  \n   位置：${h.location || "未标注"}  \n   原文：“${h.quote}”`
    );
  });
  if (result.meta?.note) {
    parts.push("", `> 说明：${result.meta.note}`);
  }
  parts.push("", "---", "## 我的理解与疑问", "- ", "- ");
  return parts.join("\n");
}
