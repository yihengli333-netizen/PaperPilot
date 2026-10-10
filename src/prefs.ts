import { DEFAULT_PREFS, PREFS, type LLMConfig } from "./types";

const PREFIX = "extensions.zotero.paperpilot.";

export function getPref(key: string): any {
  return Zotero.Prefs.get(PREFIX + key, true);
}

/** 0.7 之前的默认值；仍等于旧默认值的设置随版本升级到新默认值，用户改过的值保留 */
const LEGACY_DEFAULTS: Array<[string, number]> = [[PREFS.maxInputChars, 30000], [PREFS.timeoutMs, 60000]];
const PREFS_VERSION = 2;

/** 确保默认值已写入（不覆盖用户已设置的值） */
export function initPrefs(): void {
  const version = Number(Zotero.Prefs.get(PREFIX + PREFS.prefsVersion, true)) || 1;
  if (version < PREFS_VERSION) {
    for (const [key, old] of LEGACY_DEFAULTS) {
      if (Number(Zotero.Prefs.get(PREFIX + key, true)) === old) Zotero.Prefs.set(PREFIX + key, DEFAULT_PREFS[key], true);
    }
    Zotero.Prefs.set(PREFIX + PREFS.prefsVersion, PREFS_VERSION, true);
  }
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
    maxInputChars: Number(getPref(PREFS.maxInputChars)) || Number(DEFAULT_PREFS[PREFS.maxInputChars]),
    timeoutMs: Number(getPref(PREFS.timeoutMs)) || Number(DEFAULT_PREFS[PREFS.timeoutMs]),
    highlightCount: Number(getPref(PREFS.highlightCount)) || Number(DEFAULT_PREFS[PREFS.highlightCount]),
  };
}

export function isConfigured(): boolean {
  const c = getConfig();
  return !!c.endpoint && !!c.apiKey && !!c.model;
}
