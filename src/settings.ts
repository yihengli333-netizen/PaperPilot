/**
 * 设置面板脚本（独立窗口作用域）
 */
import { modelsURL, RELAY } from "./types";

declare const document: any;

const P = "extensions.zotero.paperpilot.";

function id(s: string) {
  return document.getElementById(s);
}

function load() {
  const g = (key: string, def: any) => {
    const v = Zotero.Prefs.get(P + key, true);
    return v === undefined || v === null ? def : v;
  };
  id("pp-endpoint").value = g("endpoint", RELAY.endpoint);
  id("pp-apiKey").value = g("apiKey", "");
  id("pp-model").value = g("model", RELAY.model);
  id("pp-language").value = g("language", "zh") === "en" ? "en" : "zh";
  id("pp-maxchars").value = g("maxInputChars", 100000);
  id("pp-timeout").value = Math.floor(Number(g("timeoutMs", 120000)) / 1000);
  id("pp-highlights").value = g("highlightCount", 6);
  id("pp-auto").checked = g("autoAnalyze", false) === true;
}

function save() {
  Zotero.Prefs.set(P + "endpoint", id("pp-endpoint").value.trim(), true);
  Zotero.Prefs.set(P + "apiKey", id("pp-apiKey").value.trim(), true);
  Zotero.Prefs.set(P + "model", id("pp-model").value.trim(), true);
  Zotero.Prefs.set(P + "language", id("pp-language").value, true);
  Zotero.Prefs.set(P + "maxInputChars", Number(id("pp-maxchars").value) || 100000, true);
  Zotero.Prefs.set(P + "timeoutMs", (Number(id("pp-timeout").value) || 120) * 1000, true);
  Zotero.Prefs.set(P + "highlightCount", Number(id("pp-highlights").value) || 6, true);
  Zotero.Prefs.set(P + "autoAnalyze", !!id("pp-auto").checked, true);
}

function status(msg: string, ok?: boolean) {
  const el = id("pp-status");
  el.textContent = msg;
  el.style.color = ok === undefined ? "#555" : ok ? "#1a7f37" : "#b3261e";
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
  const timer = setTimeout(()=>controller.abort(),30000);
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
        temperature: 0,
      }),
    });
    const text = await res.text();
    if (res.ok && JSON.parse(text)?.choices?.[0]?.message?.content) {
      status("连接成功 ✓", true);
    } else {
      status(`失败 ${res.status}：${text.slice(0, 200)}`, false);
    }
  } catch (e: any) {
    status("连接异常：" + (e?.message || e), false);
  } finally {
    clearTimeout(timer);
    id("pp-test").disabled = false;
  }
}

/** 用当前密钥读取服务端可用模型，填入模型输入框的候选列表 */
async function loadModels() {
  save();
  const url = modelsURL(id("pp-endpoint").value);
  const apiKey = id("pp-apiKey").value.trim();
  if (!url) { status("端点需以 /chat/completions 结尾才能读取模型列表", false); return; }
  if (!apiKey) { status("请先填写 API 密钥", false); return; }
  status("正在读取可用模型…");
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),20000);
  id("pp-models").disabled = true;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) { status(`读取失败 ${res.status}：${text.slice(0, 200)}`, false); return; }
    const names: string[] = (JSON.parse(text)?.data || []).map((m: any) => String(m?.id || "")).filter(Boolean).sort();
    const list = id("pp-model-list");
    list.replaceChildren(...names.map((name) => {
      const option = document.createElementNS("http://www.w3.org/1999/xhtml", "option");
      option.value = name;
      return option;
    }));
    const current = id("pp-model").value.trim();
    status(names.length
      ? `该密钥可用 ${names.length} 个模型，点击模型输入框即可选择` + (current && !names.includes(current) ? `；当前模型 ${current} 不在列表中` : "")
      : "该密钥没有可用模型，请在控制台检查令牌分组", names.length > 0 && (!current || names.includes(current)));
  } catch (e: any) {
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
  try { const n=await Zotero.PaperPilot.clearCache(); status(`已清空 ${n} 条缓存`,true); }
  catch(e:any) { status("清空失败："+e.message,false); }
}

function init() {
  load();
  const bind = (el: string, ev: string, fn: any) => {
    const e = id(el);
    if (e) e.addEventListener(ev, fn);
  };
  ["pp-endpoint", "pp-apiKey", "pp-model", "pp-language", "pp-maxchars", "pp-timeout", "pp-highlights"].forEach(
    (k) => bind(k, "change", save)
  );
  bind("pp-auto", "change", save);
  bind("pp-save", "click", () => { save(); status("设置已保存",true); });
  bind("pp-test", "click", testConnection);
  bind("pp-clear", "click", clearCache);
  bind("pp-models", "click", loadModels);
  bind("pp-default-service", "click", useDefaultService);
  bind("pp-get-key", "click", () => Zotero.launchURL(RELAY.keyURL));
}

document.addEventListener("load", function paneLoaded(event:any) {
  if (event.target.id !== "paperpilot-settings-root") return;
  document.removeEventListener("load",paneLoaded,true);
  init();
},true);
