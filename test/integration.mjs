/**
 * 集成冒烟测试：用 mock 的 Zotero 环境加载打包后的插件，
 * 验证 启动注册 → 条目面板分区渲染 → 错误路径 → 卸载 不崩溃。
 * 运行：node test/integration.mjs
 */
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const report = [];
const _log = console.log.bind(console);
console.log = (...a) => {
  const s = a.join(" ");
  report.push(s);
  _log(s);
};
process.on("exit", () => {
  try {
    writeFileSync(resolve(__dirname, "integration-report.txt"), report.join("\n"), "utf8");
  } catch (e) {}
});

// ---------- Mock 环境 ----------
const calls = { registerSection: 0, registerPane: 0, prefsSet: 0, toast: 0 };
const fakeEl = () => ({
  innerHTML: "",
  style: {},
  addEventListener() {},
  querySelectorAll: () => [],
  setAttribute() {},
  remove() {},
  id: "",
  isConnected: true,
  children: [],
  replaceChildren(...nodes) { this.children = nodes; this.firstElementChild = nodes[0]; },
  appendChild(node) { this.children.push(node); return node; },
  dataset: {},
  querySelector() { return this.children[0] || null; },
});

const PDF_ITEM = {
  id: 11,
  key: "PDFKEY",
  libraryID: 1,
  isAttachment: () => true,
  attachmentContentType: "application/pdf",
  getField: (f) => (f === "title" ? "Test Paper" : ""),
  getDisplayTitle: () => "Test Paper",
  getFilePathAsync: async () => null, // 故意返回空 → 触发错误路径
  parentItem: null,
};

const win = {
  document: {
    getElementById: () => fakeEl(),
    createXULElement: () => fakeEl(),
    createElementNS: () => { const el=fakeEl(); el.ownerDocument=win.document; return el; },
  },
  MozXULElement: { insertFTLIfNeeded() {} },
  location: { href: "chrome://zotero/content/zoteroPane.xhtml" },
  ZoteroPane: { getSelectedItems: () => [PDF_ITEM] },
  Zotero_Tabs: { select() {} },
};

global.window = win;
global.document = win.document;
global.PathUtils = { join: (...a) => a.join("/") };
global.IOUtils = { exists: async () => false, readUTF8: async () => "{}", writeUTF8: async () => {}, remove: async () => {} };
global.Cc = { "@mozilla.org/widget/clipboardhelper;1": { getService: () => ({ copyString() {} }) } };
global.Ci = { nsIClipboardHelper: {} };
global.Services = { obs: { addObserver() {}, notifyObservers() {} }, io: { newURI: (s) => s } };
global.fetch = async () => ({ ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"{}"}}]}' });

global.Zotero = {
  initializationPromise: Promise.resolve(),
  debug: () => {},
  log: () => {},
  Promise: { delay: async () => {} },
  Prefs: {
    store: {},
    get(k, g) {
      return this.store[k];
    },
    set(k, v) {
      this.store[k] = v;
      calls.prefsSet++;
    },
  },
  Items: { get: () => PDF_ITEM },
  ItemPaneManager: {
    registered: null,
    registerSection(sec) {
      calls.registerSection++;
      this.registered = sec;
      return "paperpilot-summary";
    },
    unregisterSection() {},
  },
  PreferencePanes: {
    register() {
      calls.registerPane++;
    },
    unregister() {},
  },
  Reader: { _readers: [], open: async () => {} },
  DataDirectory: { dir: "/tmp/zotero" },
  getMainWindow: () => win,
  getZoteroDirectory: () => ({ path: "/tmp/zotero" }),
  Item: function () {
    return { libraryID: 1, parentID: 0, setNote() {}, saveTx: async () => {} };
  },
  ProgressWindow: function () {
    return {
      changeHeadline() {},
      show() {},
      startCloseTimer() {},
      ItemProgress: function () {
        return { setProgress() {} };
      },
    };
  },
};
global.Zotero.ProgressWindow.prototype = {};

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
};

// ---------- 加载插件 ----------
console.log("\n[1] 加载与启动");
let loadError = null;
try {
  require(resolve(__dirname, "../addon/chrome/content/scripts/index.js"));
} catch (e) {
  loadError = e;
}
check("插件脚本可加载", !loadError, loadError && String(loadError.message));
check("导出 Zotero.PaperPilot", !!Zotero.PaperPilot);

let startError = null;
try {
  await Zotero.PaperPilot.hooks.onStartup();
} catch (e) {
  startError = e;
}
check("onStartup 无异常", !startError, startError && String(startError.stack || startError));
check("注册条目面板分区", calls.registerSection === 1);
check("注册设置面板", calls.registerPane === 1);
check("写入默认配置", calls.prefsSet > 0);

// ---------- 分区生命周期 ----------
console.log("\n[2] 条目面板分区");
const sec = Zotero.ItemPaneManager.registered;
check("分区对象存在", !!sec);
check("paneID 正确", sec.paneID === "paperpilot-summary");

let lifecycleError = null;
try {
  const setEnabled = (v) => (sec._enabled = v);
  const setSectionSummary = () => {};
  sec.onItemChange({ item: PDF_ITEM, setEnabled, setSectionSummary });
  check("有 PDF 附件时启用", sec._enabled === true);

  const body = fakeEl();
  sec.onRender({ item: PDF_ITEM, body, doc: win.document });
  check("onRender 写入 Zotero 提供的 body", body.children[0]?.id === "pp-pane-PDFKEY");

  await sec.onAsyncRender({ item: PDF_ITEM, body, doc: win.document });
  check("onAsyncRender 无异常（错误路径受控）", true);

  sec.onItemChange({
    item: { id: 2, key: "X", isAttachment: () => true, attachmentContentType: "text/html", getAttachments: () => [] },
    setEnabled: (v) => (sec._enabled2 = v),
    setSectionSummary: () => {},
  });
  check("无 PDF 时禁用", sec._enabled2 === false);
} catch (e) {
  lifecycleError = e;
}
check("生命周期无未捕获异常", !lifecycleError, lifecycleError && String(lifecycleError.stack || lifecycleError));

// ---------- 卸载 ----------
console.log("\n[3] 卸载");
let stopError = null;
try {
  await Zotero.PaperPilot.hooks.onShutdown();
} catch (e) {
  stopError = e;
}
check("onShutdown 无异常", !stopError, stopError && String(stopError.stack || stopError));

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
