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
}

export interface Highlight {
  title: string;
  description: string;
  location: string;
  quote: string;
  verified?: boolean;
  page?: number;
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

export interface LLMConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  language: "zh" | "en";
  maxInputChars: number;
  timeoutMs: number;
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

export const PREFS = {
  endpoint: "endpoint",
  apiKey: "apiKey",
  model: "model",
  language: "language",
  maxInputChars: "maxInputChars",
  timeoutMs: "timeoutMs",
  autoAnalyze: "autoAnalyze",
  highlightCount: "highlightCount",
} as const;

export const DEFAULT_PREFS: Record<string, string | number | boolean> = {
  [PREFS.endpoint]: "https://api.openai.com/v1/chat/completions",
  [PREFS.apiKey]: "",
  [PREFS.model]: "gpt-4o-mini",
  [PREFS.language]: "zh",
  [PREFS.maxInputChars]: 30000,
  [PREFS.timeoutMs]: 60000,
  [PREFS.autoAnalyze]: false,
  [PREFS.highlightCount]: 6,
};
