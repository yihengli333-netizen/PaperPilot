/**
 * PaperPilot 全局类型与常量
 */


export const ADDON_ID = "paperpilot@estriven.dev";

/** 单条结论：摘要 + 位置 + 原文片段 */
export interface Finding {
  summary: string;
  location: string;
  quote: string;
  /** 引用片段是否在原文中校验通过 */
  verified?: boolean;
  /** 页码（1 基），未知为 0 */
  page?: number;
  /** 引用经模糊匹配后已替换为原文片段 */
  corrected?: boolean;
  /** 同一类别的补充证据（0-2 条），结构同 Finding */
  evidence?: Finding[];
}

export interface Highlight {
  title: string;
  description: string;
  location: string;
  quote: string;
  verified?: boolean;
  page?: number;
  corrected?: boolean;
}

export interface SummaryResult {
  research_question: Finding;
  method: Finding;
  results: Finding;
  limitations: Finding;
  highlights: Highlight[];
  /** 元信息 */
  meta?: {
    model?: string;
    createdAt?: number;
    /** 分析覆盖情况：full | partial | unknown */
    coverage?: "full" | "partial" | "unknown";
    /** 提示信息，如"长文已截断" */
    note?: string;
    language?: string;
  };
}

export const CATEGORIES = ["research_question", "method", "results", "limitations"] as const;
export type Category = (typeof CATEGORIES)[number] | "highlight";

/** 结果中的全部引用：每类主结论、其补充证据、建议关注点。高亮、校验、索引均基于此列表。 */
export function allFindings(result: SummaryResult): Array<{ cat: Category; finding: Finding | Highlight; primary: boolean }> {
  const out: Array<{ cat: Category; finding: Finding | Highlight; primary: boolean }> = [];
  for (const cat of CATEGORIES) {
    const f = result[cat];
    if (!f) continue;
    out.push({ cat, finding: f, primary: true });
    for (const e of f.evidence || []) out.push({ cat, finding: e, primary: false });
  }
  for (const h of result.highlights || []) out.push({ cat: "highlight", finding: h, primary: true });
  return out;
}

/** 分析提示词或结果结构变化时递增，旧缓存随之失效 */
export const PROMPT_VERSION = 4;

export interface LLMConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  language: "zh" | "en";
  maxInputChars: number;
  timeoutMs: number;
  highlightCount: number;
}

export interface PageText {
  /** 0 基页码 */
  index: number;
  text: string;
}

export interface ParsedDoc {
  pages: PageText[];
  fullText: string;
  /** 是否有页码信息（false 时跳转降级） */
  hasPageInfo: boolean;
  /** 标题/摘要等元数据补充 */
  metaText: string;
  coverage: "full" | "partial";
  method: "paged" | "fulltext" | "fallback";
}

/** 默认模型服务：CCG API 中转站（OpenAI 兼容）。学生只需在控制台创建密钥并填入。 */
export const RELAY = {
  name: "CCG API",
  endpoint: "https://ccg-cli.online/v1/chat/completions",
  keyURL: "https://ccg-cli.online/ccg-console/",
  model: "gpt-6.1-sol",
  /** 设置页的推荐模型，第一项为默认 */
  presets: [
    { id: "gpt-6.1-sol", label: "默认 · gpt-6.1-sol" },
    { id: "gpt-6-luna", label: "性价比 · gpt-6-luna" },
    { id: "qwen3.8-flash", label: "中文撰写 · qwen3.8-flash" },
    { id: "claude-opus-5.5", label: "最高强度 · claude-opus-5.5" },
  ],
} as const;

/** 0.7 之前的默认服务，用于把从未配置过密钥的用户迁移到默认中转站 */
export const LEGACY_SERVICE = { endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini" } as const;

/** OpenAI 兼容的 chat/completions 端点 → 同一服务的模型列表端点；无法推断时返回 null */
export function modelsURL(endpoint: string): string | null {
  const url = endpoint.trim().replace(/\/+$/, "");
  return /\/chat\/completions$/.test(url) ? url.replace(/\/chat\/completions$/, "/models") : null;
}

export const PREFS = {
  endpoint: "endpoint",
  apiKey: "apiKey",
  model: "model",
  language: "language",
  maxInputChars: "maxInputChars",
  timeoutMs: "timeoutMs",
  autoAnalyze: "autoAnalyze",
  highlightCount: "highlightCount",
  prefsVersion: "prefsVersion",
} as const;

export const DEFAULT_PREFS: Record<string, string | number | boolean> = {
  [PREFS.endpoint]: RELAY.endpoint,
  [PREFS.apiKey]: "",
  [PREFS.model]: RELAY.model,
  [PREFS.language]: "zh",
  [PREFS.maxInputChars]: 100000,
  [PREFS.timeoutMs]: 600000,
  [PREFS.autoAnalyze]: false,
  [PREFS.highlightCount]: 6,
};
