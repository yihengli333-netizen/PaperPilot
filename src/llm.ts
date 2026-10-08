import type { LLMConfig, SummaryResult } from "./types";

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

function systemPrompt(lang: "zh" | "en", count: number): string {
  const langName = lang === "zh" ? "简体中文" : "English";
  return [
    "你是一个严谨的学术论文分析助手。",
    `请用${langName}输出，并严格遵守以下规则：`,
    "1. 只依据提供的论文正文内容作答，禁止臆测或补充外部知识。",
    "2. 每一个字段都必须附 location（章节号 + 页码，如 \"Section 3.2, Page 5\"）与 quote（正文中连续出现的完整句子或段落，20-80 字，必须能独立理解，不要只摘 1-2 个词）。",
    "3. 若正文中找不到对应内容，summary 必须写 \"未在正文中找到\"，location 与 quote 填空字符串。",
    "4. summary 每条控制在 1-2 句，直接陈述论文说了什么，不要评价好坏。",
    `5. highlights 精选 ${count} 条最值得深入阅读的位置（优先：核心公式/关键假设/主实验数据/消融对比/作者承认的重大局限）。避免罗列次要细节或重复四大类别已覆盖的内容。`,
    "6. 只输出 JSON，不要输出任何解释性文字或 markdown 代码块。",
    "",
    "JSON 结构：",
    '{',
    '  "research_question": {"summary": "", "location": "", "quote": ""},',
    '  "method": {"summary": "", "location": "", "quote": ""},',
    '  "results": {"summary": "", "location": "", "quote": ""},',
    '  "limitations": {"summary": "", "location": "", "quote": ""},',
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

export async function callLLM(
  config: LLMConfig,
  metaText: string,
  body: string,
  count: number,
  onRetry?: (msg: string) => void
): Promise<any> {
  const controller = new (Zotero.getMainWindow().AbortController)();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  const doFetch = async (extraInstruction?: string) => {
    const messages: any[] = [
      { role: "system", content: systemPrompt(config.language, count) + (extraInstruction || "") },
      { role: "user", content: userPrompt(metaText, body) },
    ];
    let res: Response;
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
        }),
        signal: controller.signal,
      });
    } catch (e: any) {
      if (e && e.name === "AbortError") {
        throw new LLMError(`请求超时（${config.timeoutMs / 1000}s），可尝试增大超时或更换模型。`, "timeout");
      }
      throw new LLMError(`无法连接模型服务：${e?.message || e}`, "network");
    }

    const text = await res.text();
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

  try {
    let raw = await doFetch();
    try {
      return extractJSON(raw);
    } catch (e) {
      onRetry?.("首次返回非 JSON，正在重试…");
      raw = await doFetch("\n重要：上一轮输出不是合法 JSON。这次只输出纯 JSON，不要任何额外文字。");
      return extractJSON(raw);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** 把模型输出规整成 SummaryResult，缺字段补空 */
export function normalizeResult(raw: any, model: string): SummaryResult {
  const f = (v: any) => ({
    summary: String(v?.summary ?? "未在正文中找到"),
    location: String(v?.location ?? ""),
    quote: String(v?.quote ?? ""),
  });
  const list = Array.isArray(raw?.highlights) ? raw.highlights : [];
  return {
    research_question: f(raw?.research_question),
    method: f(raw?.method),
    results: f(raw?.results),
    limitations: f(raw?.limitations),
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
