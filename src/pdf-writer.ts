/**
 * Write verified PDF-space line rectangles, comments, bookmarks and a mindmap appendix into a copy of a PDF.
 * Pure JS (pdf-lib), so the enhanced export no longer needs a Python installation.
 *
 * Coordinates are unrotated PDF user units, exactly as returned by Zotero getPageData.
 * No guessed paragraph/keyword boundaries or bilingual counterpart annotations.
 */
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRef } from "pdf-lib";
import type { PdfRect } from "./geo";

export type AnnotationCategory = "research_question" | "method" | "results" | "limitations" | "highlight";

export interface WriterAnnotation {
  category: AnnotationCategory;
  /** 0-based page index */
  page: number;
  rects: PdfRect[];
  quote: string;
  summary: string;
  /** L2: sentence highlight; L3: suggested-reading underline */
  layer: "L2" | "L3";
}

export interface WriterRequest {
  annotations: WriterAnnotation[];
  /** PNG bytes of the mindmap, appended as the last page */
  mindmap?: Uint8Array;
  /** Reading guide placed as a sticky note on the first page */
  guide?: string;
}

export interface WriterReport {
  bytes: Uint8Array;
  annotated: number;
  layers: { L2: number; L3: number };
  mindmap: boolean;
  pages: number;
}

const COLORS: Record<AnnotationCategory, [number, number, number]> = {
  research_question: [1, 0.831, 0], method: [0.18, 0.659, 0.898],
  results: [0.373, 0.698, 0.212], limitations: [1, 0.4, 0.4],
  highlight: [0.945, 0.596, 0.216],
};
const LABELS: Record<AnnotationCategory, string> = {
  research_question: "研究问题", method: "研究方法", results: "主要结果",
  limitations: "作者局限", highlight: "建议关注",
};

const text = (s: string) => PDFHexString.fromText(s);
const num = (n: number) => Number(n.toFixed(3));

export function validateAnnotations(annotations: WriterAnnotation[], pageCount: number): void {
  if (!annotations.length) throw new Error("没有可可靠定位的标注");
  for (const ann of annotations) {
    if (!Number.isInteger(ann.page) || ann.page < 0 || ann.page >= pageCount) throw new Error("标注页码无效");
    if (!(ann.category in COLORS) || (ann.layer !== "L2" && ann.layer !== "L3")) throw new Error("标注类别或层级无效");
    if (!ann.rects?.length) throw new Error("标注坐标为空");
    for (const r of ann.rects) {
      if (r.length !== 4 || !r.every((v) => typeof v === "number" && Number.isFinite(v))) throw new Error("标注坐标无效");
      if (r[0] >= r[2] || r[1] >= r[3]) throw new Error("标注矩形无效");
    }
  }
}

function addMarkup(doc: PDFDocument, ann: WriterAnnotation): void {
  const ctx = doc.context;
  const { rects } = ann;
  const x0 = Math.min(...rects.map((r) => r[0])), y0 = Math.min(...rects.map((r) => r[1]));
  const x1 = Math.max(...rects.map((r) => r[2])), y1 = Math.max(...rects.map((r) => r[3]));
  const color = COLORS[ann.category];
  const underline = ann.layer === "L3";
  const alpha = underline ? 1 : 0.3;
  // Explicit appearance stream: viewers that do not synthesise markup appearances still render it.
  const ops = ["q /GS gs", color.join(" ") + (underline ? " RG 1 w" : " rg")];
  for (const [a, b, c, d] of rects) {
    ops.push(underline
      ? `${num(a - x0)} ${num(b - y0 + 0.7)} m ${num(c - x0)} ${num(b - y0 + 0.7)} l S`
      : `${num(a - x0)} ${num(b - y0)} ${num(c - a)} ${num(d - b)} re f`);
  }
  ops.push("Q");
  const appearance = ctx.register(ctx.stream(ops.join("\n"), {
    Type: "XObject", Subtype: "Form", BBox: [0, 0, num(x1 - x0), num(y1 - y0)],
    Resources: { ExtGState: { GS: { ca: alpha, CA: alpha, BM: "Multiply" } } },
  }));
  const annot = ctx.obj({
    Type: "Annot",
    Subtype: underline ? "Underline" : "Highlight",
    Rect: [x0, y0, x1, y1],
    QuadPoints: rects.flatMap(([a, b, c, d]) => [a, d, c, d, a, b, c, b]),
    C: color, CA: alpha, F: 4,
    T: text("PaperPilot"),
    Contents: text(`[PP·${LABELS[ann.category]}] AI 分析：${ann.summary || ""}\n原文：${ann.quote || ""}`),
    AP: { N: appearance },
  });
  doc.getPage(ann.page).node.addAnnot(ctx.register(annot));
}

function addGuide(doc: PDFDocument, guide: string): void {
  const page = doc.getPage(0);
  const box = page.getCropBox();
  const top = box.y + box.height;
  const note = doc.context.obj({
    Type: "Annot", Subtype: "Text", Name: "Note", Open: false, F: 4,
    Rect: [box.x + 12, top - 36, box.x + 36, top - 12],
    C: COLORS.research_question, T: text("PaperPilot"), Contents: text(guide),
  });
  page.node.addAnnot(doc.context.register(note));
}

interface OutlineNode { title: string; page: number; top?: number; children: OutlineNode[] }

/** Append our outline tree after any existing bookmarks, which are left untouched. */
function addOutline(doc: PDFDocument, root: OutlineNode): void {
  const ctx = doc.context;
  const pages = doc.getPages();
  let outlinesRef = doc.catalog.get(PDFName.of("Outlines"));
  let outlines = outlinesRef ? doc.catalog.lookup(PDFName.of("Outlines")) : undefined;
  if (!(outlines instanceof PDFDict)) {
    outlines = ctx.obj({ Type: "Outlines", Count: 0 });
    outlinesRef = ctx.register(outlines);
    doc.catalog.set(PDFName.of("Outlines"), outlinesRef);
  }
  const outlinesDict = outlines as PDFDict;

  // Returns the number of visible descendants (all our items are open).
  const build = (node: OutlineNode, ref: PDFRef, parent: PDFRef): number => {
    const page = pages[node.page];
    const dest = node.top === undefined
      ? [page.ref, PDFName.of("Fit")]
      : [page.ref, PDFName.of("XYZ"), PDFNull, PDFNumber.of(num(node.top)), PDFNull];
    const dict = ctx.obj({ Title: text(node.title), Parent: parent, Dest: ctx.obj(dest) }) as PDFDict;
    let visible = 0;
    if (node.children.length) {
      const refs = node.children.map(() => ctx.nextRef());
      node.children.forEach((child, i) => {
        visible += 1 + build(child, refs[i], ref);
        const childDict = ctx.lookup(refs[i], PDFDict);
        if (i > 0) childDict.set(PDFName.of("Prev"), refs[i - 1]);
        if (i < refs.length - 1) childDict.set(PDFName.of("Next"), refs[i + 1]);
      });
      dict.set(PDFName.of("First"), refs[0]);
      dict.set(PDFName.of("Last"), refs[refs.length - 1]);
      dict.set(PDFName.of("Count"), PDFNumber.of(visible));
    }
    ctx.assign(ref, dict);
    return visible;
  };

  const rootRef = ctx.nextRef();
  const visible = build(root, rootRef, outlinesRef as PDFRef);
  const lastRef = outlinesDict.get(PDFName.of("Last"));
  if (lastRef instanceof PDFRef) {
    ctx.lookup(lastRef, PDFDict).set(PDFName.of("Next"), rootRef);
    ctx.lookup(rootRef, PDFDict).set(PDFName.of("Prev"), lastRef);
  } else {
    outlinesDict.set(PDFName.of("First"), rootRef);
  }
  outlinesDict.set(PDFName.of("Last"), rootRef);
  const count = outlinesDict.lookup(PDFName.of("Count"));
  const before = count instanceof PDFNumber ? Math.max(0, count.asNumber()) : 0;
  outlinesDict.set(PDFName.of("Count"), PDFNumber.of(before + 1 + visible));
}

export async function writeAnnotatedPDF(source: Uint8Array, request: WriterRequest): Promise<WriterReport> {
  let doc: PDFDocument;
  try {
    // updateMetadata:false keeps the original Producer/ModDate and other document info.
    // Copy into this realm: pdf-lib checks `instanceof Uint8Array`, which fails for arrays created by IOUtils.
    doc = await PDFDocument.load(new Uint8Array(source), { updateMetadata: false });
  } catch (e: any) {
    if (/encrypt/i.test(String(e?.message || e))) throw new Error("该 PDF 已加密，无法写入批注副本");
    throw new Error("无法读取 PDF：" + String(e?.message || e));
  }
  const { annotations } = request;
  validateAnnotations(annotations, doc.getPageCount());

  const layers = { L2: 0, L3: 0 };
  const root: OutlineNode = { title: "PaperPilot 阅读导航（AI 分析）", page: annotations[0].page, children: [] };
  const groups = new Map<AnnotationCategory, OutlineNode>();
  for (const ann of annotations) {
    addMarkup(doc, ann);
    layers[ann.layer]++;
    let group = groups.get(ann.category);
    if (!group) {
      group = { title: LABELS[ann.category], page: ann.page, children: [] };
      groups.set(ann.category, group);
      root.children.push(group);
    }
    const top = Math.max(...ann.rects.map((r) => r[3])) + 12;
    group.children.push({ title: (ann.summary || ann.quote || "").slice(0, 80), page: ann.page, top, children: [] });
  }
  if (request.guide) addGuide(doc, request.guide);
  if (request.mindmap) {
    const image = await doc.embedPng(request.mindmap);
    // The mindmap is rendered at 2x; place it at its CSS-pixel size.
    const width = image.width / 2, height = image.height / 2;
    const page = doc.addPage([width, height]);
    page.drawImage(image, { x: 0, y: 0, width, height });
    root.children.push({ title: "PaperPilot 思维导图（附页）", page: doc.getPageCount() - 1, children: [] });
  }
  addOutline(doc, root);
  const bytes = await doc.save();
  return { bytes, annotated: annotations.length, layers, mindmap: !!request.mindmap, pages: doc.getPageCount() };
}
