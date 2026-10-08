/**
 * 定位与跳转。
 * 设计决策：不追求精确坐标高亮（成本高、易失败）。
 * 主路径：跳转到页码；辅助：在 PDF 中搜索原文片段（内部 API，失败静默）；
 * 兜底：把片段复制到剪贴板 + 弹窗提示，用户扫一眼即可找到。
 */

export function findReader(itemID: number): any {
  try {
    const readers = Zotero.Reader._readers || [];
    return readers.find((r: any) => r.itemID === itemID && !r._isTabClosed) || null;
  } catch (e) {
    return null;
  }
}

/** Open the PDF and wait until its actual text/coordinate data is available. */
export async function ensureReader(itemID: number, timeoutMs = 30000): Promise<any> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  try {
    return await Promise.race([
      (async () => {
        // open() also activates suspended tabs; it may return undefined while a restored tab loads.
        let reader = await Zotero.Reader.open(itemID);
        while (!expired) {
          reader = findReader(itemID) || reader;
          const pdf = reader?._internalReader?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfDocument;
          if (pdf?.numPages > 0 && typeof pdf.getPageData === "function") return reader;
          // Render promises can remain pending for background/minimized windows. We need PDF data only.
          await new Promise(resolve => setTimeout(resolve,50));
        }
        throw new Error("PDF 加载超时");
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error("PDF 加载超时，请等待 PDF 显示后重试")); }, timeoutMs); }),
    ]);
  } finally { expired = true; if (timer) clearTimeout(timer); }
}

async function navigateReader(reader: any, pageIndex: number): Promise<boolean> {
  const candidates: any[] = [reader];
  const internal = reader._internalReader || reader._reader || null;
  if (internal) candidates.push(internal);

  for (const target of candidates) {
    try {
      if (typeof target.navigate === "function") {
        await target.navigate({ pageIndex });
        return true;
      }
    } catch (e) {
      /* try next */
    }
  }
  for (const target of candidates) {
    try {
      if (typeof target.gotoPage === "function") {
        await target.gotoPage(pageIndex);
        return true;
      }
    } catch (e) {
      /* try next */
    }
  }
  return false;
}

/** 尝试调用 PDF 内置搜索，高亮原文片段；失败不影响主流程 */
async function tryFind(reader: any, quote: string): Promise<boolean> {
  if (!quote) return false;
  await Zotero.Promise.delay(900);
  if (reader._initPromise) await reader._initPromise;
  const internal = reader._internalReader || reader;
  try {
    if (internal._updateState && internal._state?.primaryViewFindState) {
      const state = { primaryViewFindState: {...internal._state.primaryViewFindState, popupOpen:true, active:true, query:quote.replace(/\s+/g," ").trim(), highlightAll:true, index:null,result:null} };
      internal._updateState(Components.utils.cloneInto(state,reader._iframeWindow));
      return true;
    }
  } catch(e) { Zotero.debug("[PaperPilot] 搜索失败: "+e); }
  const tries: Array<() => any> = [
    () => internal._primaryView?._iframeWindow?.PDFViewerApplication?.findController,
    () => internal._iframeWindow?.PDFViewerApplication?.findController,
    () => internal._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer?.findController,
  ];
  for (const get of tries) {
    try {
      const fc = get();
      if (fc && typeof fc.executeCommand === "function") {
        fc.executeCommand("find", {
          query: quote.slice(0, 120),
          caseSensitive: false,
          highlightAll: true,
          findPrevious: false,
        } as any);
        return true;
      }
    } catch (e) {
      /* try next */
    }
  }
  return false;
}

export function copyToClipboard(text: string): void {
  try {
    const helper = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper);
    helper.copyString(text);
  } catch (e) {
    /* ignore */
  }
}

export function toast(title: string, body: string): void {
  try {
    const pw = new Zotero.ProgressWindow();
    pw.changeHeadline(title, "chrome://zotero/skin/markup/tick@2x.png", "");
    pw.progress = new pw.ItemProgress("chrome://zotero/skin/markup/tick@2x.png", body);
    pw.progress.setProgress(100);
    pw.show();
    pw.startCloseTimer(6000);
  } catch (e) {
    /* ignore */
  }
}

export interface GotoOptions {
  itemID: number;
  page: number; // 1 基，0 表示未知
  quote: string;
  location: string;
}

/**
 * 跳到目标位置。返回是否成功跳转（不含搜索高亮）。
 */
export async function gotoLocation(opts: GotoOptions): Promise<boolean> {
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
      /* ignore */
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
