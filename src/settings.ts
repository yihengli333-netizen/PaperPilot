/**
 * 设置面板脚本（独立窗口作用域）
 */
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
  id("pp-endpoint").value = g("endpoint", "https://api.openai.com/v1/chat/completions");
  id("pp-apiKey").value = g("apiKey", "");
  id("pp-model").value = g("model", "gpt-4o-mini");
  id("pp-language").value = g("language", "zh") === "en" ? "en" : "zh";
  id("pp-maxchars").value = g("maxInputChars", 30000);
  id("pp-timeout").value = Math.floor(Number(g("timeoutMs", 60000)) / 1000);
  id("pp-highlights").value = g("highlightCount", 6);
  id("pp-auto").checked = g("autoAnalyze", false) === true;
  if (id("pp-python")) id("pp-python").value = g("pythonPath", "");
}

function save() {
  Zotero.Prefs.set(P + "endpoint", id("pp-endpoint").value.trim(), true);
  Zotero.Prefs.set(P + "apiKey", id("pp-apiKey").value.trim(), true);
  Zotero.Prefs.set(P + "model", id("pp-model").value.trim(), true);
  Zotero.Prefs.set(P + "language", id("pp-language").value, true);
  Zotero.Prefs.set(P + "maxInputChars", Number(id("pp-maxchars").value) || 30000, true);
  Zotero.Prefs.set(P + "timeoutMs", (Number(id("pp-timeout").value) || 60) * 1000, true);
  Zotero.Prefs.set(P + "highlightCount", Number(id("pp-highlights").value) || 6, true);
  Zotero.Prefs.set(P + "autoAnalyze", !!id("pp-auto").checked, true);
  if (id("pp-python")) Zotero.Prefs.set(P + "pythonPath", id("pp-python").value.trim(), true);
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
  ["pp-endpoint", "pp-apiKey", "pp-model", "pp-language", "pp-maxchars", "pp-timeout", "pp-highlights", "pp-python"].forEach(
    (k) => bind(k, "change", save)
  );
  bind("pp-auto", "change", save);
  bind("pp-save", "click", () => { save(); status("设置已保存",true); });
  bind("pp-test", "click", testConnection);
  bind("pp-clear", "click", clearCache);
}

document.addEventListener("load", function paneLoaded(event:any) {
  if (event.target.id !== "paperpilot-settings-root") return;
  document.removeEventListener("load",paneLoaded,true);
  init();
},true);
