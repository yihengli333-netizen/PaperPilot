"use strict";
(() => {
  // src/types.ts
  var ADDON_ID = "paperpilot@estriven.dev";
  var PREFS = {
    endpoint: "endpoint",
    apiKey: "apiKey",
    model: "model",
    language: "language",
    maxInputChars: "maxInputChars",
    timeoutMs: "timeoutMs",
    autoAnalyze: "autoAnalyze",
    highlightCount: "highlightCount"
  };
  var DEFAULT_PREFS = {
    [PREFS.endpoint]: "https://api.openai.com/v1/chat/completions",
    [PREFS.apiKey]: "",
    [PREFS.model]: "gpt-4o-mini",
    [PREFS.language]: "zh",
    [PREFS.maxInputChars]: 3e4,
    [PREFS.timeoutMs]: 6e4,
    [PREFS.autoAnalyze]: false,
    [PREFS.highlightCount]: 6
  };

  // src/prefs.ts
  var PREFIX = "extensions.zotero.paperpilot.";
  function getPref(key) {
    return Zotero.Prefs.get(PREFIX + key, true);
  }
  function initPrefs() {
    for (const [key, value] of Object.entries(DEFAULT_PREFS)) {
      const current = Zotero.Prefs.get(PREFIX + key, true);
      if (current === void 0 || current === null || current === "") {
        Zotero.Prefs.set(PREFIX + key, value, true);
      }
    }
  }
  function getConfig() {
    return {
      endpoint: String(getPref(PREFS.endpoint) || DEFAULT_PREFS[PREFS.endpoint]).trim(),
      apiKey: String(getPref(PREFS.apiKey) || "").trim(),
      model: String(getPref(PREFS.model) || DEFAULT_PREFS[PREFS.model]).trim(),
      language: getPref(PREFS.language) === "en" ? "en" : "zh",
      maxInputChars: Number(getPref(PREFS.maxInputChars)) || 3e4,
      timeoutMs: Number(getPref(PREFS.timeoutMs)) || 6e4
    };
  }
  function isConfigured() {
    const c = getConfig();
    return !!c.endpoint && !!c.apiKey && !!c.model;
  }

  // src/llm.ts
  var LLMError = class extends Error {
    constructor(message, kind = "unknown") {
      super(message);
      this.kind = kind;
      this.name = "LLMError";
    }
    kind;
  };
  function truncateText(text, max) {
    if (text.length <= max) return { text, truncated: false };
    const head = Math.floor(max * 0.6);
    const tail = max - head;
    return {
      text: text.slice(0, head) + "\n\n[...中间部分已省略...]\n\n" + text.slice(-tail),
      truncated: true
    };
  }
  function systemPrompt(lang, count) {
    const langName = lang === "zh" ? "简体中文" : "English";
    return [
      "你是一个严谨的学术论文分析助手。",
      `请用${langName}输出，并严格遵守以下规则：`,
      "1. 只依据提供的论文正文内容作答，禁止臆测或补充外部知识。",
      '2. 每一个字段都必须附 location（章节号 + 页码，如 "Section 3.2, Page 5"）与 quote（正文中连续出现的完整句子或段落，20-80 字，必须能独立理解，不要只摘 1-2 个词）。',
      '3. 若正文中找不到对应内容，summary 必须写 "未在正文中找到"，location 与 quote 填空字符串。',
      "4. summary 每条控制在 1-2 句，直接陈述论文说了什么，不要评价好坏。",
      `5. highlights 精选 ${count} 条最值得深入阅读的位置（优先：核心公式/关键假设/主实验数据/消融对比/作者承认的重大局限）。避免罗列次要细节或重复四大类别已覆盖的内容。`,
      "6. 只输出 JSON，不要输出任何解释性文字或 markdown 代码块。",
      "",
      "JSON 结构：",
      "{",
      '  "research_question": {"summary": "", "location": "", "quote": ""},',
      '  "method": {"summary": "", "location": "", "quote": ""},',
      '  "results": {"summary": "", "location": "", "quote": ""},',
      '  "limitations": {"summary": "", "location": "", "quote": ""},',
      '  "highlights": [{"title": "", "description": "", "location": "", "quote": ""}]',
      "}"
    ].join("\n");
  }
  function userPrompt(metaText, body) {
    return `论文元数据：
${metaText}

论文正文：
${body}`;
  }
  function repairJSON(s) {
    let out = s.trim();
    out = out.replace(/,\s*"[^"]*"(?:\s*:)?\s*$/, "");
    out = out.replace(/:\s*"[^"]*$/, ': ""');
    out = out.replace(/,\s*$/, "");
    const quotes = (out.match(/"/g) || []).length;
    if (quotes % 2 === 1) out += '"';
    const openBrackets = (out.match(/\[/g) || []).length - (out.match(/\]/g) || []).length;
    const openBraces = (out.match(/\{/g) || []).length - (out.match(/\}/g) || []).length;
    for (let i = 0; i < openBrackets; i++) out += "]";
    for (let i = 0; i < openBraces; i++) out += "}";
    return out;
  }
  function extractJSON(raw) {
    let s = (raw || "").trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const start = s.search(/[{\[]/);
    if (start > 0) s = s.slice(start);
    try {
      return JSON.parse(s);
    } catch (e) {
    }
    const lastBrace = s.lastIndexOf("}");
    if (lastBrace > 0) {
      try {
        return JSON.parse(s.slice(0, lastBrace + 1));
      } catch (e) {
      }
    }
    try {
      return JSON.parse(repairJSON(s));
    } catch (e) {
    }
    const cuts = [s.lastIndexOf("},"), s.lastIndexOf("}\n"), s.lastIndexOf('}"')];
    const cut = Math.max(...cuts);
    if (cut > 0) {
      try {
        return JSON.parse(repairJSON(s.slice(0, cut + 1)));
      } catch (e) {
      }
    }
    throw new LLMError("模型返回的不是合法 JSON，请重试或更换模型。", "parse");
  }
  async function callLLM(config, metaText, body, count, onRetry) {
    const controller = new (Zotero.getMainWindow()).AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    const doFetch = async (extraInstruction) => {
      const messages = [
        { role: "system", content: systemPrompt(config.language, count) + (extraInstruction || "") },
        { role: "user", content: userPrompt(metaText, body) }
      ];
      let res;
      try {
        res = await fetch(config.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`
          },
          body: JSON.stringify({
            model: config.model,
            messages,
            temperature: 0.2,
            stream: false
          }),
          signal: controller.signal
        });
      } catch (e) {
        if (e && e.name === "AbortError") {
          throw new LLMError(`请求超时（${config.timeoutMs / 1e3}s），可尝试增大超时或更换模型。`, "timeout");
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
        }
        throw new LLMError(`模型服务返回 ${res.status}：${detail}`, "http");
      }
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        throw new LLMError("模型服务返回内容无法解析（可能不是 OpenAI 兼容接口）。", "http");
      }
      const content = json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text ?? json?.content ?? "";
      if (!content) throw new LLMError("模型返回内容为空。", "empty");
      return content;
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
  function normalizeResult(raw, model) {
    const f = (v) => ({
      summary: String(v?.summary ?? "未在正文中找到"),
      location: String(v?.location ?? ""),
      quote: String(v?.quote ?? "")
    });
    const list = Array.isArray(raw?.highlights) ? raw.highlights : [];
    return {
      research_question: f(raw?.research_question),
      method: f(raw?.method),
      results: f(raw?.results),
      limitations: f(raw?.limitations),
      highlights: list.slice(0, 12).map((h) => ({
        title: String(h?.title ?? "建议关注点"),
        description: String(h?.description ?? ""),
        location: String(h?.location ?? ""),
        quote: String(h?.quote ?? "")
      })),
      meta: {
        model,
        createdAt: Date.now(),
        coverage: "unknown"
      }
    };
  }

  // src/nav.ts
  function findReader(itemID) {
    try {
      const readers = Zotero.Reader._readers || [];
      return readers.find((r) => r.itemID === itemID && !r._isTabClosed) || null;
    } catch (e) {
      return null;
    }
  }
  async function ensureReader(itemID, timeoutMs = 3e4) {
    let timer;
    let expired = false;
    try {
      return await Promise.race([
        (async () => {
          let reader = await Zotero.Reader.open(itemID);
          while (!expired) {
            reader = findReader(itemID) || reader;
            const pdf = reader?._internalReader?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfDocument;
            if (pdf?.numPages > 0 && typeof pdf.getPageData === "function") return reader;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          throw new Error("PDF 加载超时");
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(new Error("PDF 加载超时，请等待 PDF 显示后重试"));
          }, timeoutMs);
        })
      ]);
    } finally {
      expired = true;
      if (timer) clearTimeout(timer);
    }
  }
  async function navigateReader(reader, pageIndex) {
    const candidates = [reader];
    const internal = reader._internalReader || reader._reader || null;
    if (internal) candidates.push(internal);
    for (const target of candidates) {
      try {
        if (typeof target.navigate === "function") {
          await target.navigate({ pageIndex });
          return true;
        }
      } catch (e) {
      }
    }
    for (const target of candidates) {
      try {
        if (typeof target.gotoPage === "function") {
          await target.gotoPage(pageIndex);
          return true;
        }
      } catch (e) {
      }
    }
    return false;
  }
  async function tryFind(reader, quote) {
    if (!quote) return false;
    await Zotero.Promise.delay(900);
    if (reader._initPromise) await reader._initPromise;
    const internal = reader._internalReader || reader;
    try {
      if (internal._updateState && internal._state?.primaryViewFindState) {
        const state = { primaryViewFindState: { ...internal._state.primaryViewFindState, popupOpen: true, active: true, query: quote.replace(/\s+/g, " ").trim(), highlightAll: true, index: null, result: null } };
        internal._updateState(Components.utils.cloneInto(state, reader._iframeWindow));
        return true;
      }
    } catch (e) {
      Zotero.debug("[PaperPilot] 搜索失败: " + e);
    }
    const tries = [
      () => internal._primaryView?._iframeWindow?.PDFViewerApplication?.findController,
      () => internal._iframeWindow?.PDFViewerApplication?.findController,
      () => internal._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer?.findController
    ];
    for (const get of tries) {
      try {
        const fc = get();
        if (fc && typeof fc.executeCommand === "function") {
          fc.executeCommand("find", {
            query: quote.slice(0, 120),
            caseSensitive: false,
            highlightAll: true,
            findPrevious: false
          });
          return true;
        }
      } catch (e) {
      }
    }
    return false;
  }
  function copyToClipboard(text) {
    try {
      const helper = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper);
      helper.copyString(text);
    } catch (e) {
    }
  }
  function toast(title, body) {
    try {
      const pw = new Zotero.ProgressWindow();
      pw.changeHeadline(title, "chrome://zotero/skin/markup/tick@2x.png", "");
      pw.progress = new pw.ItemProgress("chrome://zotero/skin/markup/tick@2x.png", body);
      pw.progress.setProgress(100);
      pw.show();
      pw.startCloseTimer(6e3);
    } catch (e) {
    }
  }
  async function gotoLocation(opts) {
    const { itemID, page, quote, location } = opts;
    copyToClipboard(quote);
    const pageIndex = Math.max(0, (page || 1) - 1);
    let reader = findReader(itemID);
    if (!reader) {
      try {
        await Zotero.Reader.open(itemID, { pageIndex });
        reader = findReader(itemID);
      } catch (e) {
        reader = null;
      }
    } else {
      if (page) await navigateReader(reader, pageIndex);
      try {
        const win = Zotero.getMainWindow();
        if (win && reader.tabID && win.Zotero_Tabs?.select) {
          win.Zotero_Tabs.select(reader.tabID);
        }
      } catch (e) {
      }
    }
    if (!reader) {
      copyToClipboard(quote);
      toast("PaperPilot", `未能打开 PDF，原文片段已复制：${quote.slice(0, 60)}…`);
      return false;
    }
    const highlighted = await tryFind(reader, quote);
    if (highlighted) {
      toast("PaperPilot", `已定位：${location || "目标页"}`);
    } else {
      copyToClipboard(quote);
      toast("PaperPilot", `${location || "目标页"} · 片段已复制到剪贴板`);
    }
    return true;
  }

  // src/parser.ts
  function normalize(text) {
    return text.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }
  async function getPath(item) {
    try {
      if (typeof item.getFilePathAsync === "function") {
        return await item.getFilePathAsync();
      }
      return item.getFilePath ? item.getFilePath() : null;
    } catch (e) {
      return null;
    }
  }
  async function extractPaged(reader) {
    try {
      const internal = reader._internalReader || reader;
      const pages = [];
      const total = internal.numPages || internal._numPages || 0;
      if (!total) return null;
      for (let i = 0; i < total; i++) {
        let text = "";
        if (typeof internal.getPageText === "function") {
          text = await internal.getPageText(i);
        } else if (internal._primaryView && typeof internal._primaryView.getPageText === "function") {
          text = await internal._primaryView.getPageText(i);
        } else {
          return null;
        }
        pages.push({ index: i, text: normalize(text || "") });
        if (i > 0 && i % 20 === 0) await Zotero.Promise.delay(0);
      }
      return pages.length ? pages : null;
    } catch (e) {
      Zotero.debug("[PaperPilot] 逐页提取失败: " + e);
      return null;
    }
  }
  async function extractFullText(itemID) {
    try {
      if (Zotero.PDFWorker && typeof Zotero.PDFWorker.getFullText === "function") {
        const text = await Zotero.PDFWorker.getFullText(itemID, null, true);
        const value = typeof text === "string" ? text : text?.text || text?.content || "";
        if (value && value.trim()) return { text: value, totalPages: text.totalPages };
      }
    } catch (e) {
      Zotero.debug("[PaperPilot] PDFWorker 提取失败: " + e);
    }
    return null;
  }
  async function parseItem(item) {
    const path = await getPath(item);
    if (!path) {
      throw new Error("找不到 PDF 文件路径（该条目可能不是本地 PDF 附件）");
    }
    let metaText = "";
    try {
      const title = item.getField ? item.getField("title") || "" : "";
      let abstract = "";
      try {
        const parent = item.parentItem;
        abstract = parent ? parent.getField("abstractNote") || "" : "";
      } catch (e) {
      }
      metaText = `TITLE: ${title}
ABSTRACT: ${abstract}`;
    } catch (e) {
    }
    const reader = findReader(item.id);
    if (reader) {
      const pages = await extractPaged(reader);
      if (pages && pages.length) {
        const fullText2 = pages.map((p) => p.text).join("\n");
        if (fullText2.length > 200) {
          return {
            pages,
            fullText: fullText2,
            hasPageInfo: true,
            metaText,
            coverage: "full",
            method: "paged"
          };
        }
      }
    }
    const extracted = await extractFullText(item.id);
    const fullText = extracted?.text || "";
    if (fullText && fullText.length > 200) {
      const parts = fullText.split("\f");
      while (parts.length > 1 && !parts[parts.length - 1].trim()) parts.pop();
      const hasPageInfo = parts.length === extracted.totalPages;
      const pages = hasPageInfo ? parts.map((text, index) => ({ index, text: normalize(text) })) : [{ index: 0, text: normalize(fullText) }];
      return {
        pages,
        fullText: hasPageInfo ? pages.map((p) => `[PDF Page ${p.index + 1}]
${p.text}`).join("\n\n") : normalize(fullText),
        hasPageInfo,
        metaText,
        coverage: "full",
        method: hasPageInfo ? "paged" : "fulltext"
      };
    }
    throw new Error(
      "无法从该 PDF 提取文本。可能是扫描件（无文本层）或文件损坏。扫描件 OCR 暂不支持。"
    );
  }
  function verifyQuote(fullText, quote) {
    if (!quote || quote.length < 6) return false;
    const norm = (s) => s.replace(/\s+/g, " ").toLowerCase().trim();
    const hay = norm(fullText);
    const needle = norm(quote);
    if (hay.includes(needle)) return true;
    return false;
  }
  function parsePage(location) {
    if (!location) return 0;
    const patterns = [
      /page\s*(\d{1,4})/i,
      /p\.\s*(\d{1,4})/i,
      /第\s*(\d{1,4})\s*页/,
      /\bpp?\.\s*(\d{1,4})/i
    ];
    for (const re of patterns) {
      const m = location.match(re);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > 0 && n < 2e3) return n;
      }
    }
    return 0;
  }

  // src/store.ts
  var FILE_NAME = "paperpilot-cache.json";
  var MAX_ENTRIES = 500;
  var cacheFile = null;
  var memory = {};
  var loaded = false;
  async function getCacheFile() {
    if (cacheFile) return cacheFile;
    const dir = Zotero.DataDirectory ? Zotero.DataDirectory.dir : Zotero.getZoteroDirectory().path;
    const file = PathUtils.join(dir, FILE_NAME);
    cacheFile = file;
    return file;
  }
  async function load() {
    if (loaded) return;
    const file = await getCacheFile();
    try {
      if (await IOUtils.exists(file)) {
        const text = await IOUtils.readUTF8(file);
        memory = JSON.parse(text || "{}");
      }
    } catch (e) {
      Zotero.debug("[PaperPilot] 缓存读取失败，使用空缓存: " + e);
      memory = {};
    }
    loaded = true;
  }
  async function persist() {
    const file = await getCacheFile();
    try {
      const keys = Object.keys(memory);
      if (keys.length > MAX_ENTRIES) {
        keys.sort((a, b) => (memory[a].createdAt || 0) - (memory[b].createdAt || 0)).slice(0, keys.length - MAX_ENTRIES).forEach((k) => delete memory[k]);
      }
      await IOUtils.writeUTF8(file, JSON.stringify(memory));
    } catch (e) {
      Zotero.debug("[PaperPilot] 缓存写入失败: " + e);
    }
  }
  async function makeKey(item) {
    try {
      const path = await item.getFilePathAsync();
      if (path) {
        const stat = await IOUtils.stat(path);
        return `v2:${item.key}:${stat.size}:${stat.lastModified}`;
      }
    } catch (e) {
    }
    return `${item.key}:v${item.version}`;
  }
  async function getCache(key) {
    await load();
    return memory[key]?.result || null;
  }
  async function setCache(key, title, model, result) {
    await load();
    memory[key] = { key, title, result, createdAt: Date.now(), model };
    await persist();
  }
  async function clearCache() {
    await load();
    const n = Object.keys(memory).length;
    memory = {};
    await persist();
    return n;
  }

  // src/analyze.ts
  function findPDFAttachment(item) {
    try {
      if (item.isAttachment && item.isAttachment()) {
        const ct = item.attachmentContentType || "";
        if (/pdf/i.test(ct) && !item.hasTag?.("PaperPilot Export")) return item;
        if (item.hasTag?.("PaperPilot Export") && item.parentItem) return findPDFAttachment(item.parentItem);
        return null;
      }
      const ids = item.getAttachments ? item.getAttachments() : [];
      for (const id of ids) {
        const att = Zotero.Items.get(id);
        if (att && !att.deleted && !att.hasTag?.("PaperPilot Export") && /pdf/i.test(att.attachmentContentType || "")) return att;
      }
    } catch (e) {
    }
    return null;
  }
  function postProcess(result, fullText) {
    const check = (f) => {
      f.verified = verifyQuote(fullText, f.quote);
      f.page = parsePage(f.location);
      return f;
    };
    result.research_question = check(result.research_question);
    result.method = check(result.method);
    result.results = check(result.results);
    result.limitations = check(result.limitations);
    result.highlights = (result.highlights || []).map(check);
    return result;
  }
  async function analyzeItem(item, opts = {}) {
    const cfg = getConfig();
    if (!cfg.apiKey) {
      throw new LLMError("尚未配置 API 密钥，请在 PaperPilot 设置中填写。", "config");
    }
    const attachment = findPDFAttachment(item);
    if (!attachment) {
      throw new LLMError("该条目没有 PDF 附件。", "no-attachment");
    }
    const key = await makeKey(attachment);
    if (!opts.force) {
      const cached = await getCache(key);
      if (cached) return { result: cached, fromCache: true };
    }
    opts.onProgress?.("正在提取 PDF 文本…");
    const doc = await parseItem(attachment);
    const { text: body, truncated } = truncateText(doc.fullText, cfg.maxInputChars);
    opts.onProgress?.("正在调用模型生成总结…");
    const raw = await callLLM(cfg, doc.metaText, body, Number(Zotero.Prefs.get("extensions.zotero.paperpilot.highlightCount", true)) || 3, opts.onProgress);
    const result = postProcess(normalizeResult(raw, cfg.model), doc.fullText);
    if (doc.hasPageInfo) {
      for (const f of [result.research_question, result.method, result.results, result.limitations, ...result.highlights]) {
        const pages = doc.pages.filter((p) => verifyQuote(p.text, f.quote));
        f.page = pages.length === 1 ? pages[0].index + 1 : 0;
        if (f.page) f.location = `PDF 第 ${f.page} 页`;
      }
    }
    result.meta = {
      model: cfg.model,
      createdAt: Date.now(),
      coverage: doc.coverage === "full" && !truncated ? "full" : "partial",
      note: [
        truncated ? "论文较长，已截断部分正文（建议核对结论）" : "",
        doc.hasPageInfo ? "页码依据原文片段逐页匹配；无法唯一匹配时请用搜索核对" : "未能获取逐页信息，模型页码未经校验，请用原文搜索核对"
      ].filter(Boolean).join("；")
    };
    await setCache(key, attachment.getField?.("title") || "", cfg.model, result);
    return {
      result,
      fromCache: false
    };
  }
  function toMarkdown(result, title) {
    const line = (label, f) => {
      const flag = f.verified ? "" : " ⚠️未校验";
      return `**${label}**：${f.summary}${flag}
   - 位置：${f.location || "未标注"}
   - 原文：${f.quote ? "“" + f.quote + "”" : "无"}`;
    };
    const parts = [
      `# ${title}`,
      "",
      `*由 PaperPilot 生成于 ${new Date(result.meta?.createdAt || Date.now()).toLocaleString("zh-CN")}${result.meta?.model ? " · 模型 " + result.meta.model : ""}*`,
      "",
      line("研究问题", result.research_question),
      "",
      line("核心方法", result.method),
      "",
      line("主要结果", result.results),
      "",
      line("作者承认的局限", result.limitations),
      "",
      "## 建议重点关注",
      ""
    ];
    (result.highlights || []).forEach((h, i) => {
      parts.push(
        `${i + 1}. **${h.title}**${h.verified ? "" : " ⚠️未校验"}  
   ${h.description}  
   位置：${h.location || "未标注"}  
   原文：“${h.quote}”`
      );
    });
    if (result.meta?.note) {
      parts.push("", `> 说明：${result.meta.note}`);
    }
    parts.push("", "---", "## 我的理解与疑问", "- ", "- ");
    return parts.join("\n");
  }

  // src/geo.ts
  var pageCache = /* @__PURE__ */ new WeakMap();
  function normalize2(s) {
    return s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  }
  function matchPage(data, quote, pageIndex) {
    let text = "";
    const offsets = [];
    data.chars.forEach((char, index) => {
      const unit = char.ignorable ? "" : normalize2(char.u ?? char.c ?? "");
      text += unit;
      for (let i = 0; i < unit.length; i++) offsets.push(index);
    });
    const start = text.indexOf(quote);
    if (start < 0) return null;
    if (text.indexOf(quote, start + 1) !== -1) return "ambiguous";
    const first = offsets[start];
    const last = offsets[start + quote.length - 1];
    const rects = [];
    for (let i = first; i <= last; i++) {
      const char = data.chars[i];
      if (char.ignorable) continue;
      if (!char.rect || char.rect.length !== 4 || !char.rect.every(Number.isFinite)) return null;
      const [a, b, c, d] = char.rect;
      const rect = [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
      if (rect[0] === rect[2] || rect[1] === rect[3]) continue;
      const prev = rects.at(-1);
      if (prev && !data.chars[i - 1]?.lineBreakAfter && Math.abs(prev[1] - rect[1]) < 1.5 && Math.abs(prev[3] - rect[3]) < 1.5 && rect[0] >= prev[0] && rect[0] - prev[2] <= 8) {
        prev[2] = Math.max(prev[2], rect[2]);
      } else rects.push(rect);
    }
    if (!rects.length) return null;
    const top = Math.max(0, Math.floor(data.viewBox[3] - Math.max(...rects.map((r) => r[3]))));
    const pad = (n, width) => String(n).padStart(width, "0").slice(0, width);
    return { pageIndex, rects, mode: "textLayer", sortIndex: `${pad(pageIndex, 5)}|${pad(first, 6)}|${pad(top, 5)}` };
  }
  async function locateQuote(ctx, quote, pageHint) {
    const needle = normalize2(quote || "");
    if (needle.length < 6 || !ctx.reader) return null;
    const view = ctx.reader._internalReader?._primaryView;
    const pdf = view?._iframeWindow?.PDFViewerApplication?.pdfDocument;
    if (!pdf || typeof pdf.getPageData !== "function") return null;
    const total = pdf.numPages;
    if (!Number.isInteger(total) || total < 1) return null;
    let cache = pageCache.get(ctx);
    if (!cache) {
      cache = /* @__PURE__ */ new Map();
      pageCache.set(ctx, cache);
    }
    const get = async (index) => {
      if (!cache.has(index)) {
        try {
          const args = typeof Components !== "undefined" && Components.utils?.cloneInto ? Components.utils.cloneInto({ pageIndex: index }, view._iframeWindow) : { pageIndex: index };
          const data = await pdf.getPageData(args);
          cache.set(index, Array.isArray(data?.chars) && data?.viewBox?.length === 4 ? data : null);
        } catch (e) {
          throw new Error(`读取 PDF 第 ${index + 1} 页坐标失败：${String(e)}`);
        }
      }
      return cache.get(index) || null;
    };
    const hinted = Number.isInteger(pageHint) && pageHint > 0 && pageHint <= total ? pageHint - 1 : -1;
    if (hinted >= 0) {
      const data = await get(hinted);
      const match = data && matchPage(data, needle, hinted);
      if (match === "ambiguous") return null;
      if (match) return match;
    }
    let found = null;
    for (let index = 0; index < total; index++) {
      const data = await get(index);
      if (!data) return null;
      const match = matchPage(data, needle, index);
      if (match === "ambiguous") return null;
      if (match) {
        if (found) return null;
        found = match;
      }
    }
    return found;
  }

  // src/annotate.ts
  var CATEGORY_COLOR = {
    research_question: "#ffd400",
    method: "#2ea8e5",
    results: "#5fb236",
    limitations: "#ff6666",
    highlight: "#f19837"
  };
  var CATEGORY_LABEL = {
    research_question: "研究问题",
    method: "方法",
    results: "结果",
    limitations: "疑点/局限",
    highlight: "建议关注"
  };
  var CATEGORY_EMOJI = {
    research_question: "🟡",
    method: "🔵",
    results: "🟢",
    limitations: "🔴",
    highlight: "🟠"
  };
  var MARK_PREFIX = "[PP·";
  var OWNER_TAG = "PaperPilot";
  var pending = /* @__PURE__ */ new Map();
  function owned(item) {
    return item?.hasTag?.(OWNER_TAG) === true && item.annotationComment?.startsWith(MARK_PREFIX);
  }
  function serialize(attachment, work) {
    const key = `${attachment.libraryID}:${attachment.id}`;
    const task = (pending.get(key) || Promise.resolve()).catch(() => {
    }).then(work);
    pending.set(key, task);
    void task.finally(() => {
      if (pending.get(key) === task) pending.delete(key);
    }).catch(() => {
    });
    return task;
  }
  function clearPilotAnnotations(attachment) {
    return serialize(attachment, async () => {
      const list = attachment.getAnnotations().filter(owned);
      let removed = 0;
      for (const item of list) {
        await item.eraseTx();
        removed++;
      }
      return removed;
    });
  }
  function annotatePDF(attachment, result, ctx) {
    return serialize(attachment, async () => {
      const stats = { created: 0, skipped: 0, existing: 0, failed: 0, errors: [] };
      const tasks = [];
      for (const cat of ["research_question", "method", "results", "limitations"]) {
        if (result[cat]?.quote) tasks.push({ cat, finding: result[cat] });
      }
      for (const finding of result.highlights || []) if (finding.quote) tasks.push({ cat: "highlight", finding });
      for (const { cat, finding: f } of tasks) {
        if (f.verified !== true) {
          stats.skipped++;
          continue;
        }
        const loc2 = await locateQuote(ctx, f.quote, f.page || 0);
        if (!loc2) {
          stats.skipped++;
          continue;
        }
        const position = { pageIndex: loc2.pageIndex, rects: loc2.rects };
        const color = CATEGORY_COLOR[cat];
        const duplicate = attachment.getAnnotations().some((a) => {
          if (!owned(a) || a.annotationText !== f.quote || a.annotationColor !== color) return false;
          try {
            return JSON.stringify(JSON.parse(a.annotationPosition)) === JSON.stringify(position);
          } catch {
            return false;
          }
        });
        if (duplicate) {
          stats.existing++;
          continue;
        }
        try {
          await Zotero.Annotations.saveFromJSON(attachment, {
            key: Zotero.DataObjectUtilities.generateKey(),
            type: "highlight",
            color,
            sortIndex: loc2.sortIndex,
            position,
            text: f.quote,
            comment: `${MARK_PREFIX}${CATEGORY_EMOJI[cat]} ${CATEGORY_LABEL[cat]}] ${"summary" in f ? f.summary : f.description}`,
            pageLabel: String(loc2.pageIndex + 1),
            tags: [{ name: OWNER_TAG }]
          });
          stats.created++;
        } catch (e) {
          stats.failed++;
          const message = e instanceof Error ? e.message : String(e);
          stats.errors.push(message);
          Zotero.debug("[PaperPilot] 高亮保存失败: " + message);
        }
      }
      return stats;
    });
  }

  // src/mindmap.ts
  var FONT = '"Microsoft YaHei","PingFang SC","Segoe UI",sans-serif';
  var NODE_H = 34;
  var GAP_Y = 14;
  var GAP_X = 70;
  var MARGIN = 24;
  var FONT_SIZE = 13;
  function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function textWidth(s) {
    let w = 0;
    for (const ch of s) {
      w += /[\x00-\xff]/.test(ch) ? FONT_SIZE * 0.62 : FONT_SIZE * 1.02;
    }
    return Math.ceil(w) + 24;
  }
  function clean(s) {
    return String(s ?? "").replace(/\s+/g, " ").trim();
  }
  function wrap(text) {
    const lines = [];
    let line = "";
    for (const ch of text) {
      if (line && textWidth(line + ch) > 380) {
        lines.push(line);
        line = "";
      }
      line += ch;
    }
    if (line || !lines.length) lines.push(line);
    return lines;
  }
  function buildTree(result, title) {
    const leaf = (cat, text) => ({
      label: clean(text),
      color: CATEGORY_COLOR[cat] || "#888888",
      children: []
    });
    const group = (cat, kids) => ({
      label: CATEGORY_LABEL[cat] || cat,
      color: CATEGORY_COLOR[cat],
      children: kids
    });
    const groups = [];
    if (result.research_question?.summary) groups.push(group("research_question", [leaf("research_question", result.research_question.summary)]));
    if (result.method?.summary) groups.push(group("method", [leaf("method", result.method.summary)]));
    if (result.results?.summary) groups.push(group("results", [leaf("results", result.results.summary)]));
    if (result.limitations?.summary) groups.push(group("limitations", [leaf("limitations", result.limitations.summary)]));
    const hlKids = (result.highlights || []).map((h) => leaf("highlight", h.title + (h.description ? "：" + h.description : "")));
    if (hlKids.length) groups.push(group("highlight", hlKids));
    return {
      label: clean(title),
      color: "#2f6fb3",
      children: groups.length ? groups : [{ label: "无可用结构", color: "#888", children: [] }]
    };
  }
  function layout(root) {
    const setW = (n) => {
      n.lines = wrap(n.label);
      n.w = Math.max(...n.lines.map(textWidth));
      n.h = Math.max(NODE_H, n.lines.length * 19 + 16);
      n.children.forEach(setW);
    };
    setW(root);
    const levelW = [];
    const collect = (n, d) => {
      levelW[d] = Math.max(levelW[d] || 0, n.w || 0);
      n.children.forEach((c) => collect(c, d + 1));
    };
    collect(root, 0);
    const levelX = [MARGIN];
    for (let i = 1; i < levelW.length; i++) {
      levelX[i] = levelX[i - 1] + (levelW[i - 1] || 0) + GAP_X;
    }
    const spans = /* @__PURE__ */ new Map();
    const measure = (n) => {
      const children = n.children.reduce((sum, c) => sum + measure(c), 0) + Math.max(0, n.children.length - 1) * GAP_Y;
      const span = Math.max(n.h || NODE_H, children);
      spans.set(n, span);
      return span;
    };
    const totalHeight = measure(root);
    const assign = (n, d, top) => {
      n.x = levelX[d];
      const span = spans.get(n);
      n.y = top + (span - (n.h || NODE_H)) / 2;
      const childrenHeight = n.children.reduce((sum, c) => sum + spans.get(c), 0) + Math.max(0, n.children.length - 1) * GAP_Y;
      let y = top + (span - childrenHeight) / 2;
      for (const c of n.children) {
        assign(c, d + 1, y);
        y += spans.get(c) + GAP_Y;
      }
    };
    assign(root, 0, MARGIN);
    const width = levelX[levelX.length - 1] + (levelW[levelW.length - 1] || 0) + MARGIN;
    const height = totalHeight + 2 * MARGIN;
    return { width, height };
  }
  function hexToSoft(hex) {
    const m = hex.replace("#", "");
    const r = parseInt(m.slice(0, 2), 16);
    const g = parseInt(m.slice(2, 4), 16);
    const b = parseInt(m.slice(4, 6), 16);
    return `rgba(${r},${g},${b},0.14)`;
  }
  function nodeSVG(n, isRoot) {
    const color = n.color || "#888888";
    const x = n.x || 0;
    const y = n.y || 0;
    const w = n.w || 0;
    const fill = isRoot ? color : hexToSoft(color);
    const stroke = color;
    const textColor = isRoot ? "#ffffff" : "#222222";
    const h = n.h || NODE_H;
    const lines = n.lines || [n.label];
    return `
  <g>
    <title>${esc(n.label)}</title>
    <rect x="${x}" y="${y}" rx="7" ry="7" width="${w}" height="${h}" fill="${fill}" stroke="${stroke}" stroke-width="1.6"/>
    <rect x="${x}" y="${y}" width="5" height="${h}" rx="2.5" ry="2.5" fill="${stroke}"/>
    <text font-family='${FONT}' font-size="${FONT_SIZE}" font-weight="${isRoot ? 700 : 500}" fill="${textColor}">${lines.map((line, i) => `<tspan x="${x + 14}" y="${y + 22 + i * 19}">${esc(line)}</tspan>`).join("")}</text>
  </g>`;
  }
  function edgeSVG(parent, child) {
    const x1 = (parent.x || 0) + (parent.w || 0);
    const y1 = (parent.y || 0) + (parent.h || NODE_H) / 2;
    const x2 = child.x || 0;
    const y2 = (child.y || 0) + (child.h || NODE_H) / 2;
    const cx = (x1 + x2) / 2;
    const color = child.color || "#aaaaaa";
    return `<path d="M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="1.6" opacity="0.8"/>`;
  }
  function renderNode(n, isRoot) {
    let s = nodeSVG(n, isRoot);
    for (const c of n.children) {
      s += edgeSVG(n, c) + renderNode(c, false);
    }
    return s;
  }
  function renderSVG(root, width, height) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  ${renderNode(root, true)}
</svg>`;
  }
  function buildMindmap(result, title) {
    const root = buildTree(result, title);
    const { width, height } = layout(root);
    const svg = renderSVG(root, width, height);
    return { svg, width, height };
  }
  async function svgToPng(svg, width, height) {
    try {
      const win = Zotero.getMainWindow();
      if (!win) return null;
      const doc = win.document;
      const img = new win.Image();
      const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("SVG 图像加载超时")), 1e4);
        img.onload = () => {
          clearTimeout(timer);
          resolve();
        };
        img.onerror = (e) => {
          clearTimeout(timer);
          reject(e);
        };
        img.src = url;
      });
      const scale = 2;
      const canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = Math.ceil(width * scale);
      canvas.height = Math.ceil(height * scale);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      return canvas.toDataURL("image/png");
    } catch (e) {
      Zotero.debug("[PaperPilot] SVG→PNG 失败: " + e);
      return null;
    }
  }
  function dataUrlToBytes(dataUrl) {
    const base64 = dataUrl.split(",")[1] || "";
    const bin = globalThis.atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  var MINDMAP_TAG = "PaperPilot Mindmap";
  function getMindmapAttachments(item) {
    const parent = item.isAttachment?.() ? item.parentItem : item;
    if (!parent?.getAttachments) return [];
    return parent.getAttachments().map((id) => Zotero.Items.get(id)).filter((att) => att && att.hasTag?.(MINDMAP_TAG) && !att.deleted).map((att) => {
      const library = Zotero.Libraries.get(att.libraryID);
      const path = library.libraryType === "group" ? `groups/${Zotero.Groups.getGroupIDFromLibraryID(att.libraryID)}` : "library";
      return { title: att.getField("title"), url: `zotero://select/${path}/items/${att.key}` };
    });
  }
  async function saveMindmap(item, out) {
    const res = { svgSaved: false, pngSaved: false, paths: [], errors: [] };
    const parent = item.isAttachment && item.isAttachment() ? item.parentItem || item : item;
    if (!parent.isRegularItem?.()) throw new Error("请先为这个 PDF 创建文献条目，再生成思维导图");
    const tmpDir = Zotero.getTempDirectory ? Zotero.getTempDirectory().path : PathUtils.join(Zotero.DataDirectory.dir, "tmp");
    try {
      await IOUtils.makeDirectory(tmpDir, { ignoreExisting: true });
    } catch (e) {
    }
    const token = Zotero.DataObjectUtilities.generateKey();
    const svgPath = PathUtils.join(tmpDir, `paperpilot-mindmap-${token}.svg`);
    try {
      await IOUtils.writeUTF8(svgPath, out.svg);
      const attachment = await Zotero.Attachments.importFromFile({
        file: svgPath,
        parentItemID: parent.id,
        libraryID: parent.libraryID,
        title: "PaperPilot 思维导图（SVG）",
        contentType: "image/svg+xml",
        rename: false
      });
      attachment.addTag(MINDMAP_TAG);
      await attachment.saveTx();
      res.svgSaved = true;
      if (attachment.getFilePathAsync) res.paths.push(await attachment.getFilePathAsync());
    } catch (e) {
      res.errors.push(String(e));
      Zotero.debug("[PaperPilot] SVG 附件保存失败: " + e);
    } finally {
      await IOUtils.remove(svgPath, { ignoreAbsent: true }).catch((e) => Zotero.debug("[PaperPilot] 临时文件清理失败: " + e));
    }
    const pngUrl = await svgToPng(out.svg, out.width, out.height);
    if (pngUrl) {
      const pngPath = PathUtils.join(tmpDir, `paperpilot-mindmap-${token}.png`);
      try {
        await IOUtils.write(pngPath, dataUrlToBytes(pngUrl));
        const attachment = await Zotero.Attachments.importFromFile({
          file: pngPath,
          parentItemID: parent.id,
          libraryID: parent.libraryID,
          title: "PaperPilot 思维导图（PNG）",
          contentType: "image/png",
          rename: false
        });
        attachment.addTag(MINDMAP_TAG);
        await attachment.saveTx();
        res.pngSaved = true;
        if (attachment.getFilePathAsync) res.paths.push(await attachment.getFilePathAsync());
      } catch (e) {
        res.errors.push(String(e));
        Zotero.debug("[PaperPilot] PNG 附件保存失败: " + e);
      } finally {
        await IOUtils.remove(pngPath, { ignoreAbsent: true }).catch((e) => Zotero.debug("[PaperPilot] 临时文件清理失败: " + e));
      }
    }
    return res;
  }

  // src/note.ts
  function esc2(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function chip(cat) {
    const c = CATEGORY_COLOR[cat] || "#888";
    return `<span style="display:inline-block;padding:1px 8px;border-radius:10px;background:${c}22;border:1px solid ${c};color:#333;font-size:11px">${esc2(CATEGORY_LABEL[cat] || cat)}</span>`;
  }
  function loc(f) {
    const p = f.page ? `第 ${f.page} 页` : f.location || "未标注页码";
    const q = f.quote ? `“${esc2(String(f.quote).slice(0, 120))}”` : "无原文片段";
    return `<div style="color:#777;font-size:11px;margin:2px 0 0">📍 ${esc2(p)} ｜ 原文：${q}${f.verified === false ? ' <span style="color:#b35900">⚠️未校验</span>' : ""}</div>`;
  }
  function section(num, cat, f, extra = "") {
    if (!f || !f.summary) return "";
    return `<div style="margin:0 0 14px">
  <div style="font-weight:600;margin:0 0 4px">${num}. ${chip(cat)} ${esc2(extra || CATEGORY_LABEL[cat])}</div>
  <div style="margin:0 0 2px">${esc2(f.summary)}</div>
  ${loc(f)}
</div>`;
  }
  function buildGuideNote(result, title, opts = {}) {
    const legend = Object.entries(CATEGORY_LABEL).map(([k, v]) => {
      const c = CATEGORY_COLOR[k];
      return `<span style="display:inline-flex;align-items:center;margin-right:12px"><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${c};margin-right:4px"></span>${esc2(v)}</span>`;
    }).join("");
    const outline = [];
    let n = 1;
    if (result.research_question?.summary) outline.push(section(n++, "research_question", result.research_question, "研究问题"));
    if (result.method?.summary) outline.push(section(n++, "method", result.method, "核心方法"));
    if (result.results?.summary) outline.push(section(n++, "results", result.results, "主要结果"));
    if (result.limitations?.summary) outline.push(section(n++, "limitations", result.limitations, "作者承认的局限"));
    const hl = (result.highlights || []).map((h, i) => {
      return `<div style="margin:0 0 12px">
      <div style="font-weight:600">${i + 1}. ${chip("highlight")} ${esc2(h.title)}</div>
      <div>${esc2(h.description)}</div>
      ${loc(h)}
    </div>`;
    }).join("");
    const mindmapBlock = `
  <div style="margin:0 0 14px;padding:10px 12px;background:#f6f9fd;border:1px solid #d9e6f2;border-radius:6px">
    <div style="font-weight:600;margin:0 0 4px">🗺️ 思维导图</div>
    <div style="color:#555;font-size:12px">${opts.mindmapSaved ? "已生成并保存为本条目附件。" + (opts.attachments || []).map((a) => `<p><a href="${esc2(a.url)}">${esc2(a.title)}</a></p>`).join("") : "尚未生成。在条目面板点击 <strong>🗺️ 思维导图</strong> 即可生成 SVG 与 PNG 附件。"}</div>
  </div>`;
    return `<h1>📄 ${esc2(title)} · PaperPilot 导读</h1>
<p style="color:#777;font-size:12px">生成于 ${new Date(result.meta?.createdAt || Date.now()).toLocaleString("zh-CN")}${result.meta?.model ? " · 模型 " + esc2(result.meta.model) : ""}</p>
<div style="margin:0 0 12px;padding:8px 10px;background:#fafafa;border:1px solid #eee;border-radius:6px;font-size:12px"><strong>颜色图例</strong>（PDF 高亮与导读一致）：<div style="margin-top:4px">${legend}</div></div>
${mindmapBlock}
<h2>📖 文章脉络大纲</h2>
${outline.join("\n") || "<p><em>未能提取大纲。</em></p>"}
<h2>📌 建议重点关注</h2>
${hl || "<p><em>无</em></p>"}
${result.meta?.note ? `<blockquote style="color:#8a6d00;border-left:3px solid #ffe58f;margin:12px 0;padding:4px 10px;background:#fffbe6">说明：${esc2(result.meta.note)}</blockquote>` : ""}
<hr/>
<h2>✍️ 我的理解与疑问</h2>
<p>&nbsp;</p>
<p>&nbsp;</p>`;
  }

  // src/pdf-export.ts
  var EXPORT_TAG = "PaperPilot Export";
  var GUIDE_PREFIX = "[PP·阅读指引]";
  function guideText(result, stats) {
    return `${GUIDE_PREFIX}
本文件已嵌入彩色高亮和中文分析批注，可在支持 PDF 批注的阅读器中查看、分享。
阅读顺序：先看蓝色的方法，再看绿色结果，最后核对红色局限与橙色建议。黄色表示研究问题。点击高亮查看对应分析。
本次定位 ${stats.created + stats.existing} 条；未可靠定位 ${stats.skipped} 条；保存失败 ${stats.failed} 条。未可靠定位的内容没有强行标注。
分析由 AI 生成，不等于作者原话；请结合高亮原文核对。
` + (result.meta?.note ? `分析范围：${result.meta.note}
` : "") + [
      ["研究问题", result.research_question],
      ["方法", result.method],
      ["结果", result.results],
      ["作者局限", result.limitations]
    ].filter(([, f]) => typeof f === "object" && f?.summary).map(
      ([label, f]) => `
${label}${f.verified ? "" : "（原文片段未校验）"}：${f.summary}`
    ).join("");
  }
  async function exportAnnotatedPDF(item, result, outputPath) {
    const att = findPDFAttachment(item);
    if (!att) throw new Error("未找到原始 PDF 附件");
    const source = await att.getFilePathAsync();
    if (!source) throw new Error("原始 PDF 文件不存在，请先下载附件");
    if (outputPath) {
      const normalized = (p) => p.replace(/\\/g, "/").toLowerCase();
      if (normalized(source) === normalized(outputPath)) throw new Error("请另存为新文件，不能覆盖原始 PDF");
      if (await IOUtils.exists(outputPath)) throw new Error("目标文件已经存在，请使用新文件名");
    }
    const reader = await ensureReader(att.id);
    const stats = await annotatePDF(att, result, { reader });
    if (!stats.created && !stats.existing) throw new Error("没有可可靠定位的高亮，未导出空白批注版。请先核对原文片段或重新分析。");
    const comment = guideText(result, stats);
    const existing = att.getAnnotations().some((a) => a.hasTag?.("PaperPilot") && a.annotationComment === comment);
    if (!existing) {
      await Zotero.Annotations.saveFromJSON(att, {
        key: Zotero.DataObjectUtilities.generateKey(),
        type: "note",
        color: "#ffd400",
        text: "",
        comment,
        pageLabel: "1",
        sortIndex: "00000|000000|00000",
        position: { pageIndex: 0, rects: [[20, 20, 42, 42]] },
        tags: [{ name: "PaperPilot" }]
      });
    }
    const parent = att.parentItem || item;
    const token = Zotero.DataObjectUtilities.generateKey();
    const path = outputPath || PathUtils.join(Zotero.getTempDirectory().path, `PaperPilot-annotated-${token}.pdf`);
    let written = false;
    try {
      const annotationCount = await Zotero.PDFWorker.export(att.id, path, true, void 0, false);
      written = true;
      if (!annotationCount || !await IOUtils.exists(path)) throw new Error("PDF 批注写入未完成，请检查文件权限");
      const attachment = await Zotero.Attachments.importFromFile({
        file: path,
        libraryID: att.libraryID,
        parentItemID: parent.isRegularItem?.() ? parent.id : void 0,
        title: `${parent.getDisplayTitle?.() || "论文"} · PaperPilot 高亮批注版`,
        contentType: "application/pdf"
      });
      attachment.addTag(EXPORT_TAG);
      await attachment.saveTx();
      return { path: outputPath || await attachment.getFilePathAsync(), attachmentID: attachment.id, stats, annotationCount };
    } catch (e) {
      if (written && outputPath) throw new Error(`PDF 已保存到 ${outputPath}，但加入文库失败：${String(e)}`);
      throw e;
    } finally {
      if (!outputPath) await IOUtils.remove(path, { ignoreAbsent: true }).catch((e) => Zotero.debug("[PaperPilot] 导出临时文件清理失败：" + e));
    }
  }

  // src/python_bridge.ts
  async function convertAnnotations(result, ctx) {
    const annotations = [];
    let skipped = 0;
    const tasks = [
      ...["research_question", "method", "results", "limitations"].map((category) => ({ category, finding: result[category] })),
      ...(result.highlights || []).map((finding) => ({ category: "highlight", finding }))
    ];
    for (const { category, finding } of tasks) {
      if (!finding?.quote) continue;
      if (finding.verified !== true) {
        skipped++;
        continue;
      }
      const loc2 = await locateQuote(ctx, finding.quote, finding.page || 0);
      if (!loc2) {
        skipped++;
        continue;
      }
      annotations.push({
        category,
        page: loc2.pageIndex,
        rects: loc2.rects,
        quote: finding.quote,
        summary: "summary" in finding ? finding.summary : finding.description,
        layer: category === "highlight" ? "L3" : "L2"
      });
    }
    return { annotations, skipped };
  }
  function runPython(binary, args, timeoutMs = 12e4) {
    return new Promise((resolve, reject) => {
      const proc = Components.classes["@mozilla.org/process/util;1"].createInstance(Components.interfaces.nsIProcess);
      proc.init(Zotero.File.pathToFile(binary));
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill();
        } catch (e) {
          reject(new Error("Python 超时且无法停止：" + String(e)));
        }
      }, timeoutMs);
      try {
        proc.runwAsync(args, args.length, { observe: (_subject, topic) => {
          clearTimeout(timer);
          if (timedOut) reject(new Error("PDF 导出超过 120 秒，后端已停止"));
          else if (topic !== "process-finished") reject(new Error("Python 进程启动或运行失败"));
          else resolve(proc.exitValue);
        } }, false);
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  }
  async function annotatePDFAdvanced(attachment, result, ctx) {
    const binary = String(getPref("pythonPath") || "").trim();
    if (!binary || !await IOUtils.exists(binary)) throw new Error("请在 PaperPilot 设置中填写已安装 pypdf 和 reportlab 的 Python 路径");
    const rootURI = Zotero.PaperPilot?.rootURI;
    if (!rootURI) throw new Error("PaperPilot 资源尚未加载，请重启 Zotero");
    const { annotations, skipped } = await convertAnnotations(result, ctx);
    if (!annotations.length) throw new Error("没有可可靠定位的引用，未生成空白批注 PDF");
    const dir = PathUtils.join(Zotero.getTempDirectory().path, "paperpilot-" + Zotero.DataObjectUtilities.generateKey());
    await IOUtils.makeDirectory(dir);
    const file = (name) => PathUtils.join(dir, name);
    try {
      await IOUtils.writeUTF8(file("pdf_annotator.py"), await Zotero.File.getResourceAsync(rootURI + "tools/pdf_annotator.py"));
      const parent = attachment.parentItem || attachment;
      const note = `AI 分析，请核对原文。已定位 ${annotations.length} 条，跳过 ${skipped} 条。` + (result.meta?.note || "") + " 点击彩色标记查看批注；蓝色方法、绿色结果、红色局限、橙色建议。";
      const map = buildMindmap(result, "PaperPilot 阅读导图｜" + (parent.getDisplayTitle?.() || "论文") + "｜" + note);
      const png = await svgToPng(map.svg, map.width, map.height);
      if (!png) throw new Error("思维导图图像生成失败，请重试导图按钮");
      const bytes = Uint8Array.from(globalThis.atob(png.split(",")[1]), (c) => c.charCodeAt(0));
      await IOUtils.write(file("mindmap.png"), bytes);
      await Zotero.PDFWorker.export(attachment.id, file("source.pdf"), true, void 0, false);
      await IOUtils.writeJSON(file("request.json"), { annotations, mindmapPath: file("mindmap.png"), guide: note });
      const exitCode = await runPython(binary, ["-X", "utf8", file("pdf_annotator.py"), file("source.pdf"), file("request.json"), file("output.pdf"), file("report.json")]);
      const report = await IOUtils.exists(file("report.json")) ? await IOUtils.readJSON(file("report.json")) : null;
      if (exitCode !== 0 || !report?.ok) throw new Error(report?.error || "Python 后端未完成。请确认该 Python 已安装 tools/requirements.txt 中的依赖");
      if (report.annotated !== annotations.length || !report.mindmap || !await IOUtils.exists(file("output.pdf"))) throw new Error("PDF 导出结果不完整");
      const saved = await Zotero.Attachments.importFromFile({
        file: file("output.pdf"),
        libraryID: attachment.libraryID,
        parentItemID: parent.isRegularItem?.() ? parent.id : void 0,
        title: `${parent.getDisplayTitle?.() || "论文"} · PaperPilot 增强批注版（含导图）`,
        contentType: "application/pdf"
      });
      saved.addTag(EXPORT_TAG);
      await saved.saveTx();
      return { path: await saved.getFilePathAsync(), attachmentID: saved.id, annotated: report.annotated, skipped, layers: report.layers };
    } finally {
      await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true }).catch((e) => Zotero.debug("[PaperPilot] 临时目录清理失败：" + e));
    }
  }

  // src/ui.ts
  var operationState = /* @__PURE__ */ new Map();
  var stateKey = (item) => item.parentItem?.id || item.id;
  function showStatus(container, item, message) {
    const key = stateKey(item);
    const state = operationState.get(key) || { message: "" };
    if (message !== void 0) {
      state.message = message;
      operationState.set(key, state);
    }
    let box = container.querySelector(".pp-status");
    if (!box) {
      box = container.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "div");
      box.className = "pp-status";
      container.appendChild(box);
    }
    box.replaceChildren();
    box.setAttribute("role", "status");
    box.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;margin-top:8px";
    const line = container.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "p");
    line.textContent = state.message;
    box.appendChild(line);
    if (state.pdfID) {
      const open = button(container.ownerDocument, "打开批注 PDF", "open-output");
      open.addEventListener("click", () => Zotero.Reader.open(state.pdfID));
      box.appendChild(open);
    }
    if (state.path) {
      const reveal = button(container.ownerDocument, "打开文件所在文件夹", "reveal-output");
      reveal.addEventListener("click", () => Zotero.File.reveal(state.path));
      box.appendChild(reveal);
    }
    if (state.svg) {
      const img = container.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "img");
      img.setAttribute("src", "data:image/svg+xml;charset=utf-8," + encodeURIComponent(state.svg));
      img.setAttribute("alt", "PaperPilot 思维导图预览");
      img.style.cssText = "display:block;width:100%;margin-top:8px";
      box.appendChild(img);
    }
  }
  function esc3(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  var STYLE = `
<style>
.pp-wrap{font-size:12px;line-height:1.6;padding:2px 0}
.pp-item{margin:0 0 10px}
.pp-label{font-weight:600;color:#2f6fb3;margin:0 0 2px}
.pp-text{margin:0 0 3px;white-space:pre-wrap;word-break:break-word}
.pp-meta{color:#777;font-size:11px;word-break:break-word}
.pp-link{color:#2f6fb3;cursor:pointer;text-decoration:underline;margin-right:8px}
.pp-link:hover{color:#134a80}
.pp-flag{color:#b35900}
.pp-hl{border-left:3px solid #d9e6f2;padding:4px 0 4px 8px;margin:0 0 8px}
.pp-hl-title{font-weight:600}
.pp-actions{margin-top:8px;display:flex;flex-wrap:wrap;gap:6px}
.pp-btn{font-size:11px;padding:2px 8px;cursor:pointer}
.pp-note{background:#fffbe6;border:1px solid #ffe58f;padding:6px 8px;border-radius:3px;margin:8px 0;color:#8a6d00}
.pp-empty{color:#888;font-style:italic}
.pp-quote{color:#555;font-style:italic}
.pp-legend{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 10px}
.pp-lg{display:inline-flex;align-items:center;font-size:11px;color:#444}
.pp-lg i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:4px}
.pp-idx{margin:6px 0 10px}
.pp-idx-cat{font-size:11px;font-weight:600;margin:8px 0 3px;display:flex;align-items:center}
.pp-idx-cat i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:5px}
.pp-idx-item{display:flex;justify-content:space-between;gap:6px;padding:2px 2px 2px 16px;cursor:pointer;border-radius:3px;font-size:11px}
.pp-idx-item:hover{background:#f2f6fb}
.pp-idx-item .pp-idx-title{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pp-idx-item .pp-idx-page{color:#999;flex:none}
</style>`;
  function html(container, markup) {
    const doc = container.ownerDocument;
    const root = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    root.innerHTML = markup;
    container.replaceChildren(root);
  }
  function button(doc, text, action) {
    const el = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
    el.className = "pp-btn";
    el.textContent = text;
    el.dataset.ppAct = action;
    return el;
  }
  function addButtons(container, actions) {
    const root = container.firstElementChild || container;
    let actionsEl = root.querySelector(".pp-actions");
    if (!actionsEl) {
      actionsEl = root.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "div");
      actionsEl.className = "pp-actions";
      root.appendChild(actionsEl);
    }
    actionsEl.replaceChildren(...actions.map(([text, action]) => button(root.ownerDocument, text, action)));
  }
  function addResultButtons(container) {
    addButtons(container, [
      ["📄 导出带批注 PDF", "exportPDF"],
      ["🖍️ 在 Zotero 中标注", "highlight"],
      ["🧹 清除本插件批注", "clearHl"],
      ["🗺️ 思维导图", "mindmap"],
      ["💾 保存导读", "save"],
      ["📋 复制MD", "copy"],
      ["📑 导出增强批注 PDF（含导图）", "advancedAnnotate"],
      ["🔄 重新分析", "reload"]
    ]);
  }
  function findingHTML(label, f) {
    if (!f || !f.summary && !f.quote) {
      return `<div class="pp-item"><div class="pp-label">${esc3(label)}</div><div class="pp-empty">未在正文中找到</div></div>`;
    }
    const badge = f.verified ? "" : ' <span class="pp-flag">⚠️片段未校验</span>';
    const jump = f.page || f.quote ? `<span class="pp-link" data-pp-jump="1" data-page="${f.page || 0}" data-quote="${esc3(
      (f.quote || "").slice(0, 160)
    )}">📍 ${esc3(f.location || "跳转")}</span>` : "";
    return `<div class="pp-item">
    <div class="pp-label">${esc3(label)}${badge}</div>
    <div class="pp-text">${esc3(f.summary)}</div>
    <div class="pp-meta">${jump}${f.quote ? `<span class="pp-quote">“${esc3(f.quote.slice(0, 80))}”</span>` : ""}</div>
  </div>`;
  }
  function legendHTML() {
    const items = Object.entries(CATEGORY_LABEL).map(([k, v]) => {
      const c = CATEGORY_COLOR[k];
      return `<span class="pp-lg"><i style="background:${c}"></i>${esc3(v)}</span>`;
    }).join("");
    return `<div class="pp-legend">${items}</div>`;
  }
  function indexHTML(result) {
    const group = (cat, items) => {
      if (!items.length) return "";
      const c = CATEGORY_COLOR[cat];
      const rows = items.map((f) => {
        const title = f.title || f.summary || CATEGORY_LABEL[cat];
        const page = f.page ? `p.${f.page}` : "";
        return `<div class="pp-idx-item" data-pp-jump="1" data-page="${f.page || 0}" data-quote="${esc3(
          (f.quote || "").slice(0, 160)
        )}" title="${esc3(f.summary || f.description || "")}">
          <span class="pp-idx-title">${esc3(title)}</span><span class="pp-idx-page">${page}</span>
        </div>`;
      }).join("");
      return `<div class="pp-idx-cat"><i style="background:${c}"></i>${esc3(CATEGORY_LABEL[cat])}</div>${rows}`;
    };
    const parts = [
      group("research_question", result.research_question?.summary ? [result.research_question] : []),
      group("method", result.method?.summary ? [result.method] : []),
      group("results", result.results?.summary ? [result.results] : []),
      group("limitations", result.limitations?.summary ? [result.limitations] : []),
      group("highlight", result.highlights || [])
    ].filter(Boolean);
    if (!parts.length) return "";
    return `<div class="pp-idx"><div class="pp-label" style="margin:0 0 2px">🗂️ 导读索引（点击跳转）</div>${parts.join("")}</div>`;
  }
  function summaryHTML(result, fromCache) {
    const hs = (result.highlights || []).map((h) => {
      const badge = h.verified ? "" : ' <span class="pp-flag">⚠️</span>';
      const jump = h.page || h.quote ? `<span class="pp-link" data-pp-jump="1" data-page="${h.page || 0}" data-quote="${esc3(
        (h.quote || "").slice(0, 160)
      )}">📍 ${esc3(h.location || "跳转")}</span>` : "";
      return `<div class="pp-hl">
        <div class="pp-hl-title">${esc3(h.title)}${badge}</div>
        <div class="pp-text">${esc3(h.description)}</div>
        <div class="pp-meta">${jump}</div>
      </div>`;
    }).join("");
    const note = result.meta?.note ? `<div class="pp-note">${esc3(result.meta.note)}</div>` : "";
    const unverified = [
      result.research_question,
      result.method,
      result.results,
      result.limitations,
      ...result.highlights || []
    ].filter((f) => f && !f.verified).length;
    const warn = unverified > 0 ? `<div class="pp-note">有 ${unverified} 条引用片段未在原文中匹配到（已标 ⚠️），请点击 📍 自行核对。</div>` : "";
    return `${STYLE}<div class="pp-wrap">
    ${note}${warn}
    ${legendHTML()}
    ${indexHTML(result)}
    ${findingHTML("🎯 研究问题", result.research_question)}
    ${findingHTML("🔬 核心方法", result.method)}
    ${findingHTML("📊 主要结果", result.results)}
    ${findingHTML("⚠️ 作者承认的局限", result.limitations)}
    <div class="pp-label" style="margin-top:10px">📌 建议重点关注</div>
    ${hs || '<div class="pp-empty">无</div>'}
    <div class="pp-actions"></div>
    <div class="pp-meta" style="margin-top:6px">${fromCache ? "来自缓存 · " : ""}${esc3(result.meta?.model || "")}</div>
  </div>`;
  }
  async function runAnalyze(container, item, force, auto) {
    if (!isConfigured()) {
      html(container, `${STYLE}<div class="pp-wrap"><div class="pp-note">尚未配置模型服务。请在 Zotero 设置 → PaperPilot 中填写 API 端点、密钥与模型。</div></div>`);
      addButtons(container, [["模型设置", "settings"], ["重试", "reload"]]);
      bind(container, item, null);
      return;
    }
    html(container, `${STYLE}<div class="pp-wrap"><div class="pp-empty">正在分析论文…（首次约需 10-60 秒）</div></div>`);
    try {
      const { result, fromCache } = await analyzeItem(item, { force });
      if (!container.isConnected) return;
      html(container, summaryHTML(result, fromCache));
      addResultButtons(container);
      bind(container, item, result);
    } catch (e) {
      html(container, `${STYLE}<div class="pp-wrap">
      <div class="pp-note">分析失败：${esc3(e?.message || e)}</div>
      <div class="pp-actions"></div>
    </div>`);
      addButtons(container, [["重试", "reload"]]);
      bind(container, item, null);
      if (auto) toast("PaperPilot", "分析失败：" + (e?.message || e));
    }
  }
  async function doHighlight(item, result) {
    const att = findPDFAttachment(item);
    if (!att) {
      throw new Error("未找到 PDF 附件");
    }
    toast("PaperPilot", "正在写入 PDF 高亮与批注…");
    const reader = await ensureReader(att.id);
    const stats = await annotatePDF(att, result, {
      reader
    });
    return `新增 ${stats.created} 条高亮，已有 ${stats.existing} 条。` + (stats.skipped ? `${stats.skipped} 条未通过引用校验或未找到唯一坐标，可点击 📍 搜索核对。` : "") + (stats.failed ? `${stats.failed} 条保存失败：${stats.errors[0]}。旧高亮已保留。` : "") + "\n分享文件请点击“导出带批注 PDF”。";
  }
  async function doClearHighlight(item) {
    const att = findPDFAttachment(item);
    if (!att) {
      toast("PaperPilot", "未找到 PDF 附件");
      return;
    }
    const n = await clearPilotAnnotations(att);
    toast("PaperPilot", `已清除 ${n} 条 PaperPilot 高亮`);
    return n;
  }
  async function doMindmap(item, result) {
    const title = item.getDisplayTitle ? item.getDisplayTitle() : "论文";
    toast("PaperPilot", "正在生成思维导图…");
    const out = buildMindmap(result, title);
    const res = await saveMindmap(item, out);
    if (!res.svgSaved && !res.pngSaved) throw new Error("思维导图附件保存失败：" + res.errors.join("；"));
    toast(
      "PaperPilot",
      `思维导图已生成：SVG ${res.svgSaved ? "✓" : "✗"} · PNG ${res.pngSaved ? "✓" : "✗"}（见本条目附件）`
    );
    return { out, res };
  }
  async function doAdvancedAnnotate(item, result) {
    const att = findPDFAttachment(item);
    if (!att) {
      throw new Error("未找到 PDF 附件");
    }
    toast("PaperPilot", "正在定位引用并生成带导图的 PDF 副本…");
    const reader = await ensureReader(att.id);
    const ctx = { reader };
    return annotatePDFAdvanced(att, result, ctx);
  }
  async function saveGuideNote(item, result) {
    const title = item.getDisplayTitle ? item.getDisplayTitle() : "论文";
    const attachments = getMindmapAttachments(item);
    const html2 = buildGuideNote(result, title, { mindmapSaved: attachments.length > 0, attachments });
    try {
      const parent = item.isAttachment && item.isAttachment() ? item.parentItem || item : item;
      const note = new Zotero.Item("note");
      note.libraryID = parent.libraryID;
      if (parent.isRegularItem && parent.isRegularItem()) note.parentID = parent.id;
      note.setNote(html2);
      await note.saveTx();
      toast("PaperPilot", "导读已保存为条目笔记");
    } catch (e) {
      throw new Error("保存失败：" + (e?.message || e));
    }
  }
  function bind(container, item, result) {
    container.querySelectorAll("[data-pp-jump]").forEach((el) => {
      el.addEventListener("click", async () => {
        const att = findPDFAttachment(item);
        if (!att) {
          toast("PaperPilot", "未找到 PDF 附件");
          return;
        }
        const page = Number(el.dataset.page || 0);
        const quote = el.dataset.quote || "";
        await gotoLocation({ itemID: att.id, page, quote, location: "" });
      });
    });
    container.querySelectorAll("[data-pp-act]").forEach((el) => {
      el.addEventListener("click", async () => {
        const act = el.dataset.ppAct;
        if (act === "settings") {
          Zotero.PaperPilot.openSettings();
          return;
        }
        if (act === "reload" || act === "generate") {
          await runAnalyze(container, item, act === "reload", false);
          return;
        }
        if (!result) return;
        const key = stateKey(item);
        if (operationState.get(key)?.busy) return;
        operationState.set(key, { ...operationState.get(key), message: "正在处理，请稍候…", busy: true });
        showStatus(container, item);
        try {
          if (act === "highlight") {
            showStatus(container, item, await doHighlight(item, result));
          } else if (act === "advancedAnnotate") {
            const output = await doAdvancedAnnotate(item, result);
            operationState.set(key, { message: `增强批注 PDF 已生成：${output.layers.L2} 条句子高亮、${output.layers.L3} 条建议片段下划线，均带分析批注。
已附阅读导图和书签；${output.skipped} 条未可靠定位，已跳过。原始 PDF 保留。
文件：${output.path}`, pdfID: output.attachmentID, path: output.path });
            showStatus(container, item);
          } else if (act === "exportPDF") {
            const output = await exportAnnotatedPDF(item, result);
            operationState.set(key, { message: `批注 PDF 已生成，包含 ${output.stats.created + output.stats.existing} 条高亮和中文分析批注。
${output.stats.skipped} 条未可靠定位，未强行标注。
文件：${output.path}`, pdfID: output.attachmentID, path: output.path });
            showStatus(container, item);
            toast("PaperPilot", "批注 PDF 已保存到本论文的附件中");
          } else if (act === "clearHl") {
            const n = await doClearHighlight(item);
            showStatus(container, item, `已清除 ${n || 0} 条 PaperPilot 批注。之前导出的 PDF 副本保持不变。`);
          } else if (act === "mindmap") {
            const { out, res } = await doMindmap(item, result);
            operationState.set(key, { message: `思维导图已生成：SVG ${res.svgSaved ? "✓" : "✗"} · PNG ${res.pngSaved ? "✓" : "✗"}。
见下方预览与本条目附件。` + (res.errors.length ? "\n" + res.errors.join("；") : ""), svg: out.svg, path: res.paths.at(-1) });
            showStatus(container, item);
          } else if (act === "save") {
            await saveGuideNote(item, result);
            showStatus(container, item, "导读已保存为本论文的子笔记。");
          } else if (act === "copy") {
            const md = toMarkdown(result, item.getDisplayTitle ? item.getDisplayTitle() : "论文");
            copyToClipboard(md);
            toast("PaperPilot", "已复制 Markdown 到剪贴板");
            showStatus(container, item, "已复制 Markdown 到剪贴板。");
          }
        } catch (e) {
          showStatus(container, item, "操作失败：" + (e?.message || e));
          toast("PaperPilot", "操作失败：" + (e?.message || e));
        } finally {
          const state = operationState.get(key);
          if (state) state.busy = false;
        }
      });
    });
  }
  var sectionID;
  function unregisterSection() {
    if (sectionID) Zotero.ItemPaneManager.unregisterSection(sectionID);
  }
  function registerSection() {
    if (!Zotero.ItemPaneManager) throw new Error("PaperPilot：当前 Zotero 不支持条目面板接口");
    const icon = Zotero.PaperPilot?.rootURI ? Zotero.PaperPilot.rootURI + "chrome/skin/icon.svg" : "chrome://zotero/skin/16/universal/document.svg";
    sectionID = Zotero.ItemPaneManager.registerSection({
      paneID: "paperpilot-summary",
      pluginID: ADDON_ID,
      header: {
        l10nID: "paperpilot-section-header",
        icon
      },
      sidenav: { l10nID: "paperpilot-section-sidenav", icon },
      sectionButtons: [
        {
          type: "refresh",
          icon: "chrome://zotero/skin/16/universal/refresh@2x.png",
          l10nID: "paperpilot-refresh",
          onClick: async ({ item, body }) => {
            await runAnalyze(
              body.querySelector(".pp-container"),
              item,
              true,
              false
            );
          }
        }
      ],
      onItemChange: ({ item, setEnabled, setSectionSummary }) => {
        const has = !!findPDFAttachment(item);
        setEnabled(has);
        setSectionSummary(has ? "" : "无 PDF 附件");
      },
      onInit: ({ doc }) => {
        doc.defaultView?.MozXULElement?.insertFTLIfNeeded("paperpilot.ftl");
      },
      onRender: ({ item, body, doc }) => {
        const container = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
        container.id = `pp-pane-${item.key}`;
        container.className = "pp-container";
        body.replaceChildren(container);
        html(container, `${STYLE}<p>选好论文后，点击下面的按钮。</p><div class="pp-actions"></div>`);
        addButtons(container, [["生成总结", "generate"], ["模型设置", "settings"]]);
        bind(container, item, null);
        showStatus(container, item);
      },
      onAsyncRender: async ({ item, body }) => {
        const container = body.querySelector(".pp-container");
        const att = findPDFAttachment(item);
        if (!att || !container) return;
        const cached = await getCache(await makeKey(att));
        if (!container.isConnected) return;
        if (cached) {
          html(container, summaryHTML(cached, true));
          addResultButtons(container);
          bind(container, item, cached);
          showStatus(container, item);
        } else if (Zotero.Prefs.get("extensions.zotero.paperpilot.autoAnalyze", true) === true) await runAnalyze(container, item, false, true);
      },
      onDestroy: () => {
      }
    });
    if (!sectionID) throw new Error("PaperPilot：条目面板注册失败，请查看 Zotero 错误报告");
  }
  async function analyzeSelected() {
    const win = Zotero.getMainWindow();
    const items = win?.ZoteroPane?.getSelectedItems() || [];
    if (!items.length) {
      toast("PaperPilot", "请先选中一个条目");
      return;
    }
    let ok = 0;
    const failures = [];
    const unique = [...new Map(items.map((i) => {
      const parent = i.parentItem || i;
      return [parent.id, parent];
    })).values()];
    for (const item of unique) {
      try {
        const { result } = await analyzeItem(item);
        await saveGuideNote(item, result);
        ok++;
      } catch (e) {
        failures.push(`${item.getDisplayTitle?.() || "条目"}：${e.message}`);
      }
    }
    toast("PaperPilot", `已保存 ${ok} 篇` + (failures.length ? `；失败 ${failures.length} 篇：${failures.join("；")}` : ""));
  }

  // src/index.ts
  var MENU_IDS = {
    tools: "paperpilot-tools-analyze",
    item: "paperpilot-item-analyze"
  };
  function log(msg) {
    Zotero.debug("[PaperPilot] " + msg);
  }
  function addMenuItem(win, popupId, id, label, handler) {
    try {
      const popup = win.document.getElementById(popupId);
      if (!popup || win.document.getElementById(id)) return;
      const mi = win.document.createXULElement("menuitem");
      mi.id = id;
      mi.setAttribute("label", label);
      mi.setAttribute("tooltiptext", "PaperPilot：生成总结并保存为笔记");
      mi.addEventListener("command", handler);
      popup.appendChild(mi);
    } catch (e) {
      log("菜单注册失败: " + e);
    }
  }
  function removeMenuItems(win) {
    Object.values(MENU_IDS).forEach((id) => {
      try {
        const el = win.document.getElementById(id);
        if (el) el.remove();
      } catch (e) {
      }
    });
  }
  var hooks = {
    async onStartup() {
      try {
        await Zotero.initializationPromise;
        initPrefs();
        log("启动，版本 0.6.1");
        try {
          if (Zotero.PreferencePanes) {
            await Zotero.PreferencePanes.register({
              id: "paperpilot-settings",
              pluginID: ADDON_ID,
              src: "chrome/content/settings.xhtml",
              scripts: ["chrome/content/scripts/settings.js"],
              label: "PaperPilot",
              image: "chrome/skin/icon.svg",
              defaultXUL: false
            });
          }
        } catch (e) {
          log("设置面板注册失败: " + e);
        }
        try {
          registerSection();
        } catch (e) {
          log("条目面板注册失败: " + e);
        }
        await hooks.onMainWindowLoad({ window: Zotero.getMainWindow() });
      } catch (e) {
        log("启动失败: " + e);
      }
    },
    async onMainWindowLoad({ window: win }) {
      if (!win) return;
      try {
        if (win.MozXULElement && typeof win.MozXULElement.insertFTLIfNeeded === "function") {
          win.MozXULElement.insertFTLIfNeeded("paperpilot.ftl");
        }
      } catch (e) {
        log("FTL 加载失败: " + e);
      }
      addMenuItem(win, "menu_ToolsPopup", MENU_IDS.tools, "PaperPilot：生成总结并保存为笔记", () => {
        analyzeSelected();
      });
      addMenuItem(win, "zotero-itemmenu", MENU_IDS.item, "PaperPilot：生成总结并保存为笔记", () => {
        analyzeSelected();
      });
    },
    async onMainWindowUnload({ window: win }) {
      if (!win) return;
      removeMenuItems(win);
    },
    async onShutdown() {
      try {
        const win = Zotero.getMainWindow();
        if (win) removeMenuItems(win);
        if (Zotero.ItemPaneManager?.unregisterSection) {
          unregisterSection();
        }
        if (Zotero.PreferencePanes?.unregister) {
          Zotero.PreferencePanes.unregister("paperpilot-settings");
        }
        delete Zotero.PaperPilot;
        log("已卸载");
      } catch (e) {
        log("卸载异常: " + e);
      }
    }
  };
  Zotero.PaperPilot = {
    id: ADDON_ID,
    version: "0.6.1",
    hooks,
    analyzeSelected,
    clearCache,
    openSettings: () => Zotero.Utilities.Internal.openPreferences("paperpilot-settings")
  };
})();
