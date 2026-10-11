/** Locate a quote using Zotero Reader's native character rectangles. */
import { canon, findSpan } from "./text";

export type PdfRect = [number, number, number, number];
interface PdfChar {
  c?: string;
  u?: string;
  rect: PdfRect;
  ignorable?: boolean;
  lineBreakAfter?: boolean;
}
interface PageData { chars: PdfChar[]; viewBox: PdfRect }
export interface LocateResult {
  pageIndex: number;
  rects: PdfRect[];
  mode: "textLayer";
  sortIndex: string;
  /** Matched with small text differences rather than exactly */
  fuzzy?: boolean;
  /** Only part of the quote was found (it continues on the neighbouring page) */
  partial?: boolean;
}
export interface LocateContext { reader: any }
const pageCache = new WeakMap<LocateContext, Map<number, PageData | null>>();
const textCache = new WeakMap<PageData, { text: string; offsets: number[] }>();

function pageText(data: PageData) {
  let cached = textCache.get(data);
  if (!cached) {
    let text = "";
    const offsets: number[] = [];
    data.chars.forEach((char, index) => {
      const unit = char.ignorable ? "" : canon(char.u ?? char.c ?? "");
      text += unit;
      for (let i = 0; i < unit.length; i++) offsets.push(index);
    });
    cached = { text, offsets };
    textCache.set(data, cached);
  }
  return cached;
}

function rectsFor(data: PageData, first: number, last: number, pageIndex: number): LocateResult | null {
  const rects: PdfRect[] = [];
  for (let i = first; i <= last; i++) {
    const char = data.chars[i];
    if (char.ignorable) continue;
    if (!char.rect || char.rect.length !== 4 || !char.rect.every(Number.isFinite)) return null;
    const [a,b,c,d] = char.rect;
    const rect: PdfRect = [Math.min(a,c), Math.min(b,d), Math.max(a,c), Math.max(b,d)];
    if (rect[0] === rect[2] || rect[1] === rect[3]) continue;
    const prev = rects.at(-1);
    // Never join separate columns or different lines into a single rectangle.
    if (prev && !data.chars[i-1]?.lineBreakAfter && Math.abs(prev[1]-rect[1]) < 1.5
      && Math.abs(prev[3]-rect[3]) < 1.5 && rect[0] >= prev[0] && rect[0]-prev[2] <= 8) {
      prev[2] = Math.max(prev[2],rect[2]);
    } else rects.push(rect);
  }
  if (!rects.length) return null;
  const top = Math.max(0, Math.floor(data.viewBox[3] - Math.max(...rects.map(r=>r[3]))));
  const pad = (n: number, width: number) => String(n).padStart(width, "0").slice(0,width);
  return {pageIndex, rects, mode:"textLayer", sortIndex:`${pad(pageIndex,5)}|${pad(first,6)}|${pad(top,5)}`};
}

/**
 * Match on one page. Without a page hint an exact quote occurring twice is ambiguous; with the page known
 * (from verification) the first occurrence is used. Fuzzy matching tolerates small differences between the
 * text used for verification and the reader's character data (symbol order, broken glyphs).
 */
function matchPage(data: PageData, needle: string, pageIndex: number, hinted: boolean): LocateResult | "ambiguous" | null {
  const { text, offsets } = pageText(data);
  const span = findSpan(text, needle, hinted);
  if (span === "ambiguous") return span;
  if (!span) return null;
  const result = rectsFor(data, offsets[span.start], offsets[span.end - 1], pageIndex);
  if (result && !span.exact) result.fuzzy = true;
  return result;
}

/** No character coordinates or an ambiguous location => no annotation. Never guesses a page or rectangle. */
export async function locateQuote(ctx: LocateContext, quote: string, pageHint: number): Promise<LocateResult | null> {
  const needle = canon(quote || "");
  if (needle.length < 6 || !ctx.reader) return null;
  const view = ctx.reader._internalReader?._primaryView;
  const pdf = view?._iframeWindow?.PDFViewerApplication?.pdfDocument;
  if (!pdf || typeof pdf.getPageData !== "function") return null;
  const total = pdf.numPages;
  if (!Number.isInteger(total) || total < 1) return null;
  let cache = pageCache.get(ctx);
  if (!cache) { cache = new Map(); pageCache.set(ctx,cache); }
  const get = async (index: number) => {
    if (!cache.has(index)) {
      try {
        // PDF.js forwards this object to its worker; privileged sandbox objects cannot be cloned there.
        const args = typeof Components !== "undefined" && Components.utils?.cloneInto
          ? Components.utils.cloneInto({pageIndex:index},view._iframeWindow)
          : {pageIndex:index};
        const data = await pdf.getPageData(args);
        cache.set(index, Array.isArray(data?.chars) && data?.viewBox?.length === 4 ? data : null);
      } catch(e) { throw new Error(`读取 PDF 第 ${index+1} 页坐标失败：${String(e)}`); }
    }
    return cache.get(index) || null;
  };
  const hinted = Number.isInteger(pageHint) && pageHint > 0 && pageHint <= total ? pageHint-1 : -1;
  const search = async (target: string): Promise<LocateResult | null> => {
    if (hinted >= 0) {
      const data = await get(hinted);
      const match = data && matchPage(data,target,hinted,true);
      if (match && match !== "ambiguous") return match;
    }
    let found: LocateResult | null = null;
    for (let index=0; index<total; index++) {
      const data = await get(index);
      if (!data) continue; // 个别页没有文字层（插图页等）不影响其他页的定位
      const match = matchPage(data,target,index,false);
      if (match === "ambiguous") return null;
      if (match) {
        // The same sentence on two pages cannot be placed reliably; a fuzzy hit yields to an exact one.
        if (found && !found.fuzzy && !match.fuzzy) return null;
        if (!found || (found.fuzzy && !match.fuzzy)) found = match;
      }
    }
    return found;
  };
  const whole = await search(needle);
  if (whole) return whole;
  // A quote that runs onto the next page: highlight the part that is on a single page.
  if (needle.length >= 60) {
    const cut = Math.floor(needle.length * 0.55);
    for (const part of [needle.slice(0, cut), needle.slice(needle.length - cut)]) {
      const found = await search(part);
      if (found) return {...found, partial: true};
    }
  }
  return null;
}
