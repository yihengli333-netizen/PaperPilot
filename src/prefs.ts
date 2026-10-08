import { DEFAULT_PREFS, PREFS, type LLMConfig } from "./types";

const PREFIX = "extensions.zotero.paperpilot.";

export function getPref(key: string): any {
  return Zotero.Prefs.get(PREFIX + key, true);
}

/** 确保默认值已写入（不覆盖用户已设置的值） */
export function initPrefs(): void {
  for (const [key, value] of Object.entries(DEFAULT_PREFS)) {
    const current = Zotero.Prefs.get(PREFIX + key, true);
    if (current === undefined || current === null || current === "") {
      Zotero.Prefs.set(PREFIX + key, value, true);
    }
  }
}

export function getConfig(): LLMConfig {
  return {
    endpoint: String(getPref(PREFS.endpoint) || DEFAULT_PREFS[PREFS.endpoint]).trim(),
    apiKey: String(getPref(PREFS.apiKey) || "").trim(),
    model: String(getPref(PREFS.model) || DEFAULT_PREFS[PREFS.model]).trim(),
    language: (getPref(PREFS.language) === "en" ? "en" : "zh") as "zh" | "en",
    maxInputChars: Number(getPref(PREFS.maxInputChars)) || 30000,
    timeoutMs: Number(getPref(PREFS.timeoutMs)) || 60000,
  };
}

export function isConfigured(): boolean {
  const c = getConfig();
  return !!c.endpoint && !!c.apiKey && !!c.model;
}
