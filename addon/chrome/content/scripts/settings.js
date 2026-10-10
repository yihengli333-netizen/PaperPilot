"use strict";
(() => {
  // src/types.ts
  var RELAY = {
    name: "CCG API",
    endpoint: "https://ccg-cli.online/v1/chat/completions",
    keyURL: "https://ccg-cli.online/ccg-console/",
    model: "doubao-seed-2.0-lite"
  };
  function modelsURL(endpoint) {
    const url = endpoint.trim().replace(/\/+$/, "");
    return /\/chat\/completions$/.test(url) ? url.replace(/\/chat\/completions$/, "/models") : null;
  }
  var PREFS = {
    endpoint: "endpoint",
    apiKey: "apiKey",
    model: "model",
    language: "language",
    maxInputChars: "maxInputChars",
    timeoutMs: "timeoutMs",
    autoAnalyze: "autoAnalyze",
    highlightCount: "highlightCount",
    prefsVersion: "prefsVersion"
  };
  var DEFAULT_PREFS = {
    [PREFS.endpoint]: RELAY.endpoint,
    [PREFS.apiKey]: "",
    [PREFS.model]: RELAY.model,
    [PREFS.language]: "zh",
    [PREFS.maxInputChars]: 1e5,
    [PREFS.timeoutMs]: 3e5,
    [PREFS.autoAnalyze]: false,
    [PREFS.highlightCount]: 6
  };

  // src/settings.ts
  var P = "extensions.zotero.paperpilot.";
  function id(s) {
    return document.getElementById(s);
  }
  function load() {
    const g = (key, def) => {
      const v = Zotero.Prefs.get(P + key, true);
      return v === void 0 || v === null ? def : v;
    };
    id("pp-endpoint").value = g("endpoint", RELAY.endpoint);
    id("pp-apiKey").value = g("apiKey", "");
    id("pp-model").value = g("model", RELAY.model);
    id("pp-language").value = g("language", "zh") === "en" ? "en" : "zh";
    id("pp-maxchars").value = g("maxInputChars", 1e5);
    id("pp-timeout").value = Math.floor(Number(g("timeoutMs", 3e5)) / 1e3);
    id("pp-highlights").value = g("highlightCount", 6);
    id("pp-auto").checked = g("autoAnalyze", false) === true;
  }
  function save() {
    Zotero.Prefs.set(P + "endpoint", id("pp-endpoint").value.trim(), true);
    Zotero.Prefs.set(P + "apiKey", id("pp-apiKey").value.trim(), true);
    Zotero.Prefs.set(P + "model", id("pp-model").value.trim(), true);
    Zotero.Prefs.set(P + "language", id("pp-language").value, true);
    Zotero.Prefs.set(P + "maxInputChars", Number(id("pp-maxchars").value) || 1e5, true);
    Zotero.Prefs.set(P + "timeoutMs", (Number(id("pp-timeout").value) || 300) * 1e3, true);
    Zotero.Prefs.set(P + "highlightCount", Number(id("pp-highlights").value) || 6, true);
    Zotero.Prefs.set(P + "autoAnalyze", !!id("pp-auto").checked, true);
  }
  function status(msg, ok) {
    const el = id("pp-status");
    el.textContent = msg;
    el.style.color = ok === void 0 ? "#555" : ok ? "#1a7f37" : "#b3261e";
  }
  async function testConnection() {
    save();
    const endpoint = id("pp-endpoint").value.trim();
    const apiKey = id("pp-apiKey").value.trim();
    const model = id("pp-model").value.trim();
    if (!endpoint || !apiKey || !model) {
      status("请先填写端点、密钥与模型", false);
      return;
    }
    status("正在测试…");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3e4);
    id("pp-test").disabled = true;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with OK" }],
          max_tokens: 5,
          temperature: 0
        })
      });
      const text = await res.text();
      if (res.ok && JSON.parse(text)?.choices?.[0]?.message?.content) {
        status("连接成功 ✓", true);
      } else {
        status(`失败 ${res.status}：${text.slice(0, 200)}`, false);
      }
    } catch (e) {
      status("连接异常：" + (e?.message || e), false);
    } finally {
      clearTimeout(timer);
      id("pp-test").disabled = false;
    }
  }
  async function loadModels() {
    save();
    const url = modelsURL(id("pp-endpoint").value);
    const apiKey = id("pp-apiKey").value.trim();
    if (!url) {
      status("端点需以 /chat/completions 结尾才能读取模型列表", false);
      return;
    }
    if (!apiKey) {
      status("请先填写 API 密钥", false);
      return;
    }
    status("正在读取可用模型…");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2e4);
    id("pp-models").disabled = true;
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: controller.signal });
      const text = await res.text();
      if (!res.ok) {
        status(`读取失败 ${res.status}：${text.slice(0, 200)}`, false);
        return;
      }
      const names = (JSON.parse(text)?.data || []).map((m) => String(m?.id || "")).filter(Boolean).sort();
      const list = id("pp-model-list");
      list.replaceChildren(...names.map((name) => {
        const option = document.createElementNS("http://www.w3.org/1999/xhtml", "option");
        option.value = name;
        return option;
      }));
      const current = id("pp-model").value.trim();
      status(names.length ? `该密钥可用 ${names.length} 个模型，点击模型输入框即可选择` + (current && !names.includes(current) ? `；当前模型 ${current} 不在列表中` : "") : "该密钥没有可用模型，请在控制台检查令牌分组", names.length > 0 && (!current || names.includes(current)));
    } catch (e) {
      status("读取异常：" + (e?.message || e), false);
    } finally {
      clearTimeout(timer);
      id("pp-models").disabled = false;
    }
  }
  function useDefaultService() {
    id("pp-endpoint").value = RELAY.endpoint;
    if (!id("pp-model").value.trim()) id("pp-model").value = RELAY.model;
    save();
    status(`已切换到 ${RELAY.name} 默认端点`, true);
  }
  async function clearCache() {
    try {
      const n = await Zotero.PaperPilot.clearCache();
      status(`已清空 ${n} 条缓存`, true);
    } catch (e) {
      status("清空失败：" + e.message, false);
    }
  }
  function init() {
    load();
    const bind = (el, ev, fn) => {
      const e = id(el);
      if (e) e.addEventListener(ev, fn);
    };
    ["pp-endpoint", "pp-apiKey", "pp-model", "pp-language", "pp-maxchars", "pp-timeout", "pp-highlights"].forEach(
      (k) => bind(k, "change", save)
    );
    bind("pp-auto", "change", save);
    bind("pp-save", "click", () => {
      save();
      status("设置已保存", true);
    });
    bind("pp-test", "click", testConnection);
    bind("pp-clear", "click", clearCache);
    bind("pp-models", "click", loadModels);
    bind("pp-default-service", "click", useDefaultService);
    bind("pp-get-key", "click", () => Zotero.launchURL(RELAY.keyURL));
  }
  document.addEventListener("load", function paneLoaded(event) {
    if (event.target.id !== "paperpilot-settings-root") return;
    document.removeEventListener("load", paneLoaded, true);
    init();
  }, true);
})();
