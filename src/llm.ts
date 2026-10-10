import { CATEGORIES, type Finding, type LLMConfig, type SummaryResult } from "./types";

export class LLMError extends Error {
  constructor(message: string, public kind: string = "unknown") {
    super(message);
    this.name = "LLMError";
  }
}

/** 长文截断：保留开头与结尾，中间用标记连接 */
export function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return {
    text: text.slice(0, head) + "\n\n[...中间部分已省略...]\n\n" + text.slice(-tail),
    truncated: true,
  };
}

/** 章节类型与优先级：数值越大越优先保留；0 表示直接丢弃 */
const SECTION_RULES: Array<[RegExp, string, number]> = [
  [/^(abstract|摘\s*要)$/, "abstract", 5],
  [/^(introduction|引\s*言|绪\s*论|前\s*言)$/, "introduction", 3],
  [/^(related\s+works?|background|preliminar(y|ies)|literature\s+review|相关工作|研究背景|文献综述)$/, "related", 1],
  [/^(methods?|methodology|approach|proposed\s+method|model|framework|materials\s+and\s+methods|研究方法|方法|模型)$/, "method", 4],
  [/^(experiments?|experimental\s+(setup|results)|evaluation|results(\s+and\s+discussion)?|实验|实验结果|结果|结果与讨论)$/, "results", 4],
  [/^(discussion|analysis|ablation(\s+stud(y|ies))?|讨论|分析)$/, "discussion", 3],
  [/^(limitations?|threats\s+to\s+validity|局限性?|不足)$/, "limitations", 5],
  [/^(conclusions?|concluding\s+remarks|summary|future\s+work|结论|总结|结语)$/, "conclusion", 5],
  [/^(appendix|appendices|supplementary(\s+material)?|附录)/, "appendix", 0],
  [/^(references|bibliography|参考文献)$/, "references", 0],
  [/^(acknowledge?ments?|funding|致谢)$/, "acknowledgements", 0],
];

interface Section { kind: string; priority: number; text: string }

function classifyHeading(line: string): [string, number] | null {
  const t = line.trim();
  if (t.length > 60 || t.length < 2) return null;
  // 去掉编号："3", "3.", "III.", "A.", "第三章"
  const title = t.replace(/^((\d+(\.\d+)*|[IVX]+|[A-H])\.?\s+|第[一二三四五六七八九十\d]+[章节]\s*)/, "").replace(/[:：.]$/, "").toLowerCase();
  // 子章节（3.1）只算为所在章节的一部分
  if (/^\d+\.\d+/.test(t)) return null;
  for (const [re, kind, priority] of SECTION_RULES) if (re.test(title)) return [kind, priority];
  return null;
}

/** 按章节标题切分正文；识别不到至少两个章节时返回 null */
export function splitSections(text: string): Section[] | null {
  const sections: Section[] = [];
  let current: Section = { kind: "front", priority: 5, text: "" };
  for (const line of text.split("\n")) {
    const heading = classifyHeading(line);
    if (heading) {
      if (current.text.trim()) sections.push(current);
      current = { kind: heading[0], priority: heading[1], text: line + "\n" };
    } else current.text += line + "\n";
  }
  if (current.text.trim()) sections.push(current);
  return sections.filter((s) => s.kind !== "front").length >= 2 ? sections : null;
}

/**
 * 长文压缩：先丢弃参考文献/致谢/附录，再按章节优先级分配字数，每节保留开头。
 * 识别不到章节结构时退回首尾截断。partial 表示正文章节本身被截短；omitted 为整节丢弃的章节类型。
 */
export function condenseText(text: string, max: number): { text: string; truncated: boolean; partial: boolean; omitted: string[] } {
  if (text.length <= max) return { text, truncated: false, partial: false, omitted: [] };
  const sections = splitSections(text);
  if (!sections) return { ...truncateText(text, max), partial: true, omitted: [] };
  const omitted = [...new Set(sections.filter((s) => s.priority === 0).map((s) => s.kind))];
  const kept = sections.filter((s) => s.priority > 0);
  const total = kept.reduce((n, s) => n + s.text.length, 0);
  if (total <= max) return { text: kept.map((s) => s.text).join(""), truncated: true, partial: false, omitted };
  // 按优先级加权分配预算；短章节用不完的额度在下一轮分给其他章节
  const budget = new Map<Section, number>();
  let remaining = max;
  let open = kept.slice();
  while (open.length && remaining > 0) {
    const weight = open.reduce((n, s) => n + s.priority, 0);
    const next: Section[] = [];
    let spent = 0;
    for (const s of open) {
      const share = Math.floor((remaining * s.priority) / weight);
      const have = budget.get(s) || 0;
      const want = s.text.length - have;
      const give = Math.min(share, want);
      budget.set(s, have + give);
      spent += give;
      if (give < want) next.push(s);
    }
    remaining -= spent;
    if (next.length === open.length && spent === 0) break;
    open = next;
  }
  const marker = "\n[...本节其余部分已省略...]\n";
  const parts = kept.map((s) => {
    const n = budget.get(s) || 0;
    return n >= s.text.length ? s.text : s.text.slice(0, Math.max(0, n - marker.length)) + marker;
  });
  return { text: parts.join(""), truncated: true, partial: true, omitted };
}

function systemPrompt(lang: "zh" | "en", count: number): string {
  const langName = lang === "zh" ? "简体中文" : "English";
  return [
    "你是一个严谨的学术论文分析助手。",
    `请用${langName}输出，并严格遵守以下规则：`,
    "1. 只依据提供的论文正文内容作答，禁止臆测或补充外部知识。",
    "2. 每一个字段都必须附 location（章节号 + 页码，如 \"Section 3.2, Page 5\"）与 quote。quote 必须从正文逐字复制（保持原文语言，不翻译、不改写、不省略中间部分），是连续出现的一到两个完整句子（约 20-60 个词或 30-120 个汉字），能独立理解，不要只摘 1-2 个词。正文中的 [PDF Page N] 是页码标记，不属于原文，quote 不要跨越它。",
    "3. 若正文中找不到对应内容，summary 必须写 \"未在正文中找到\"，location 与 quote 填空字符串。",
    "4. summary 每条控制在 1-2 句，直接陈述论文说了什么，不要评价好坏。",
    "4a. 四个类别各可附 evidence：0-2 条补充证据（结构与主字段相同），用于主 quote 之外同样关键的原文，例如另一组主实验数据、第二个关键假设。没有就给空数组，不要重复主 quote。",
    `5. highlights 精选 ${count} 条最值得深入阅读的位置（优先：核心公式/关键假设/主实验数据/消融对比/作者承认的重大局限）。避免罗列次要细节或重复四大类别已覆盖的内容。`,
    "6. 只输出 JSON，不要输出任何解释性文字或 markdown 代码块。",
    "",
    "JSON 结构：",
    '{',
    '  "research_question": {"summary": "", "location": "", "quote": "", "evidence": [{"summary": "", "location": "", "quote": ""}]},',
    '  "method": {"summary": "", "location": "", "quote": "", "evidence": [{"summary": "", "location": "", "quote": ""}]},',
    '  "results": {"summary": "", "location": "", "quote": "", "evidence": [{"summary": "", "location": "", "quote": ""}]},',
    '  "limitations": {"summary": "", "location": "", "quote": "", "evidence": [{"summary": "", "location": "", "quote": ""}]},',
    '  "highlights": [{"title": "", "description": "", "location": "", "quote": ""}]',
    '}',
  ].join("\n");
}

function userPrompt(metaText: string, body: string): string {
  return `论文元数据：\n${metaText}\n\n论文正文：\n${body}`;
}

/** 修补被截断的 JSON：悬空逗号、未闭合字符串、缺失括号 */
function repairJSON(s: string): string {
  let out = s.trim();
  // 1) 去掉末尾悬空的 ", "key":"
  out = out.replace(/,\s*"[^"]*"(?:\s*:)?\s*$/, "");
  // 2) 键后面跟着未闭合的字符串：整体置空
  out = out.replace(/:\s*"[^"]*$/, ': ""');
  // 3) 末尾悬空逗号
  out = out.replace(/,\s*$/, "");
  // 4) 补齐字符串引号
  const quotes = (out.match(/"/g) || []).length;
  if (quotes % 2 === 1) out += '"';
  // 5) 补齐括号
  const openBrackets = (out.match(/\[/g) || []).length - (out.match(/\]/g) || []).length;
  const openBraces = (out.match(/\{/g) || []).length - (out.match(/\}/g) || []).length;
  for (let i = 0; i < openBrackets; i++) out += "]";
  for (let i = 0; i < openBraces; i++) out += "}";
  return out;
}

/** 从回复文本中稳健地取出 JSON */
export function extractJSON(raw: string): any {
  let s = (raw || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.search(/[{\[]/);
  if (start > 0) s = s.slice(start);
  try {
    return JSON.parse(s);
  } catch (e) {
    /* 进入修补流程 */
  }

  // 尝试 1：截到最后一个完整的大括号
  const lastBrace = s.lastIndexOf("}");
  if (lastBrace > 0) {
    try {
      return JSON.parse(s.slice(0, lastBrace + 1));
    } catch (e) {
      /* 进入尝试 2 */
    }
  }

  // 尝试 2：结构修补（应对输出被 max_tokens 截断）
  try {
    return JSON.parse(repairJSON(s));
  } catch (e) {
    /* 继续 */
  }

  // 尝试 3：截断到最后一个完整的 "}," 边界再修补
  const cuts = [s.lastIndexOf("},"), s.lastIndexOf("}\n"), s.lastIndexOf('}"')];
  const cut = Math.max(...cuts);
  if (cut > 0) {
    try {
      return JSON.parse(repairJSON(s.slice(0, cut + 1)));
    } catch (e) {
      /* 继续 */
    }
  }

  throw new LLMError("模型返回的不是合法 JSON，请重试或更换模型。", "parse");
}

/** 按端点记录是否支持 response_format（本次运行内有效） */
const jsonModeSupported = new Map<string, boolean>();

export async function callLLM(
  config: LLMConfig,
  metaText: string,
  body: string,
  count: number,
  onRetry?: (msg: string) => void
): Promise<any> {
  // 每次请求单独计时：重试不应继承上一次已消耗的时间
  const doFetch = async (extraInstruction?: string, jsonMode = jsonModeSupported.get(config.endpoint) !== false): Promise<string> => {
    const messages: any[] = [
      { role: "system", content: systemPrompt(config.language, count) + (extraInstruction || "") },
      { role: "user", content: userPrompt(metaText, body) },
    ];
    const controller = new (Zotero.getMainWindow().AbortController)();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await fetch(config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: 0.2,
          stream: false,
          ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: controller.signal,
      });
      text = await res.text();
    } catch (e: any) {
      if (e && e.name === "AbortError") {
        throw new LLMError(`请求超时（${config.timeoutMs / 1000}s），可尝试增大超时或更换模型。`, "timeout");
      }
      throw new LLMError(`无法连接模型服务：${e?.message || e}`, "network");
    } finally {
      clearTimeout(timer);
    }

    // 不支持 JSON 模式的服务会以 400/422 拒绝该参数（错误文案各家不同）：去掉参数重发一次，成功则记住
    if (jsonMode && (res.status === 400 || res.status === 422)) {
      const content = await doFetch(extraInstruction, false);
      jsonModeSupported.set(config.endpoint, false);
      return content;
    }
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        detail = j.error?.message || j.message || detail;
      } catch (e) {
        /* ignore */
      }
      throw new LLMError(`模型服务返回 ${res.status}：${detail}`, "http");
    }

    let json: any;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new LLMError("模型服务返回内容无法解析（可能不是 OpenAI 兼容接口）。", "http");
    }

    const content =
      json?.choices?.[0]?.message?.content ??
      json?.choices?.[0]?.text ??
      json?.content ??
      "";
    if (!content) throw new LLMError("模型返回内容为空。", "empty");
    return content as string;
  };

  let raw = await doFetch();
  try {
    return extractJSON(raw);
  } catch (e) {
    onRetry?.("首次返回非 JSON，正在重试…");
    raw = await doFetch("\n重要：上一轮输出不是合法 JSON。这次只输出纯 JSON，不要任何额外文字。");
    return extractJSON(raw);
  }
}

/** 把模型输出规整成 SummaryResult，缺字段补空 */
export function normalizeResult(raw: any, model: string): SummaryResult {
  const base = (v: any): Finding => ({
    summary: String(v?.summary ?? "未在正文中找到"),
    location: String(v?.location ?? ""),
    quote: String(v?.quote ?? ""),
  });
  const f = (v: any): Finding => {
    const primary = base(v);
    const evidence = (Array.isArray(v?.evidence) ? v.evidence : [])
      .map(base)
      .filter((e: Finding) => e.quote && e.quote !== primary.quote)
      .slice(0, 2);
    return evidence.length ? { ...primary, evidence } : primary;
  };
  const list = Array.isArray(raw?.highlights) ? raw.highlights : [];
  const out: any = {};
  for (const cat of CATEGORIES) out[cat] = f(raw?.[cat]);
  return {
    ...out,
    highlights: list.slice(0, 12).map((h: any) => ({
      title: String(h?.title ?? "建议关注点"),
      description: String(h?.description ?? ""),
      location: String(h?.location ?? ""),
      quote: String(h?.quote ?? ""),
    })),
    meta: {
      model,
      createdAt: Date.now(),
      coverage: "unknown",
    },
  };
}
