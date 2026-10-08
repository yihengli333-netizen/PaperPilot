import { findReader } from "./nav";
import type { PageText, ParsedDoc } from "./types";

/**
 * PDF 文本提取。
 * 策略优先级：
 *  1) 已打开的 Reader：尝试逐页读取（可获得页码）
 *  2) Zotero.PDFWorker.getFullText：全文（无页码，跳转降级）
 * 任一失败都显式抛出，不做静默伪造。
 */

function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function getPath(item: any): Promise<string | null> {
  try {
    if (typeof item.getFilePathAsync === "function") {
      return await item.getFilePathAsync();
    }
    return item.getFilePath ? item.getFilePath() : null;
  } catch (e) {
    return null;
  }
}

async function extractPaged(reader: any): Promise<PageText[] | null> {
  try {
    const internal = reader._internalReader || reader;
    const pages: PageText[] = [];
    const total: number = internal.numPages || internal._numPages || 0;
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

async function extractFullText(itemID: number): Promise<any> {
  try {
    if (Zotero.PDFWorker && typeof Zotero.PDFWorker.getFullText === "function") {
      const text = await Zotero.PDFWorker.getFullText(itemID, null, true);
      const value = typeof text === "string" ? text : text?.text || text?.content || "";
      if (value && value.trim()) return {text: value, totalPages: text.totalPages};
    }
  } catch (e) {
    Zotero.debug("[PaperPilot] PDFWorker 提取失败: " + e);
  }
  return null;
}

export async function parseItem(item: any): Promise<ParsedDoc> {
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
      /* ignore */
    }
    metaText = `TITLE: ${title}\nABSTRACT: ${abstract}`;
  } catch (e) {
    /* ignore */
  }

  // 1) Reader 逐页
  const reader = findReader(item.id);
  if (reader) {
    const pages = await extractPaged(reader);
    if (pages && pages.length) {
      const fullText = pages.map((p) => p.text).join("\n");
      if (fullText.length > 200) {
        return {
          pages,
          fullText,
          hasPageInfo: true,
          metaText,
          coverage: "full",
          method: "paged",
        };
      }
    }
  }

  // 2) 全文
  const extracted = await extractFullText(item.id);
  const fullText = extracted?.text || "";
  if (fullText && fullText.length > 200) {
    const parts = fullText.split("\f");
    while (parts.length > 1 && !parts[parts.length - 1].trim()) parts.pop();
    const hasPageInfo = parts.length === extracted.totalPages;
    const pages = hasPageInfo ? parts.map((text: string,index: number)=>({index,text:normalize(text)})) : [{index:0,text:normalize(fullText)}];
    return {
      pages,
      fullText: hasPageInfo ? pages.map((p:any)=>`[PDF Page ${p.index+1}]\n${p.text}`).join("\n\n") : normalize(fullText),
      hasPageInfo,
      metaText,
      coverage: "full",
      method: hasPageInfo ? "paged" : "fulltext",
    };
  }

  throw new Error(
    "无法从该 PDF 提取文本。可能是扫描件（无文本层）或文件损坏。扫描件 OCR 暂不支持。"
  );
}

/** 在原文中校验引用片段（忽略空白差异） */
export function verifyQuote(fullText: string, quote: string): boolean {
  if (!quote || quote.length < 6) return false;
  const norm = (s: string) => s.replace(/\s+/g, " ").toLowerCase().trim();
  const hay = norm(fullText);
  const needle = norm(quote);
  if (hay.includes(needle)) return true;
  return false;
}

/** 从 location 描述里解析页码（1 基；失败返回 0） */
export function parsePage(location: string): number {
  if (!location) return 0;
  const patterns = [
    /page\s*(\d{1,4})/i,
    /p\.\s*(\d{1,4})/i,
    /第\s*(\d{1,4})\s*页/,
    /\bpp?\.\s*(\d{1,4})/i,
  ];
  for (const re of patterns) {
    const m = location.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > 0 && n < 2000) return n;
    }
  }
  return 0;
}
