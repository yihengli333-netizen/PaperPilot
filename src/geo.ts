/** Locate a complete quote using Zotero Reader's native character rectangles. */
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
}
export interface LocateContext { reader: any }
const pageCache = new WeakMap<LocateContext, Map<number, PageData | null>>();
function normalize(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}
function matchPage(data: PageData, quote: string, pageIndex: number): LocateResult | "ambiguous" | null {
  let text = "";
  const offsets: number[] = [];
  data.chars.forEach((char, index) => {
    const unit = char.ignorable ? "" : normalize(char.u ?? char.c ?? "");
    text += unit;
    for (let i = 0; i < unit.length; i++) offsets.push(index);
  });
  const start = text.indexOf(quote);
  if (start < 0) return null;
  if (text.indexOf(quote, start + 1) !== -1) return "ambiguous";
  const first = offsets[start];
  const last = offsets[start + quote.length - 1];
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

/** No character coordinates, partial match, or ambiguous location => no annotation. */
export async function locateQuote(ctx: LocateContext, quote: string, pageHint: number): Promise<LocateResult | null> {
  const needle = normalize(quote || "");
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
  if (hinted >= 0) {
    const data = await get(hinted);
    const match = data && matchPage(data,needle,hinted);
    if (match === "ambiguous") return null;
    if (match) return match;
  }
  let found: LocateResult | null = null;
  for (let index=0; index<total; index++) {
    const data = await get(index);
    if (!data) return null;
    const match = matchPage(data,needle,index);
    if (match === "ambiguous") return null;
    if (match) {
      if (found) return null;
      found = match;
    }
  }
  return found;
}
