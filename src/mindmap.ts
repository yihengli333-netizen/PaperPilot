/**
 * 思维导图：自绘 SVG 树状布局（零外部依赖，系统字体，中文安全）。
 * 结构：论文标题 → 核心结论/方法/结果/疑点(局限)/建议关注 → 各要点。
 * 颜色与 PDF 高亮类别一致。输出 SVG 字符串 + 可选 PNG dataURL。
 */
import { CATEGORY_COLOR, CATEGORY_LABEL } from "./annotate";
import type { SummaryResult } from "./types";


export interface MNode {
  label: string;
  color?: string;
  children: MNode[];
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  lines?: string[];
}

const FONT = '"Microsoft YaHei","PingFang SC","Segoe UI",sans-serif';
const NODE_H = 34;
const GAP_Y = 14;
const GAP_X = 70;
const MARGIN = 24;
const FONT_SIZE = 13;

function esc(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += /[\x00-\xff]/.test(ch) ? FONT_SIZE * 0.62 : FONT_SIZE * 1.02;
  }
  return Math.ceil(w) + 24;
}

function clean(s: string): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function wrap(text: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (const ch of text) {
    if (line && textWidth(line + ch) > 380) { lines.push(line); line = ""; }
    line += ch;
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}

/** 构建树：根 → 类别 → 要点 */
export function buildTree(result: SummaryResult, title: string): MNode {
  const leaf = (cat: string, text: string): MNode => ({
    label: clean(text),
    color: CATEGORY_COLOR[cat] || "#888888",
    children: [],
  });
  const group = (cat: string, kids: MNode[]): MNode => ({
    label: CATEGORY_LABEL[cat] || cat,
    color: CATEGORY_COLOR[cat],
    children: kids,
  });

  const groups: MNode[] = [];
  if (result.research_question?.summary) groups.push(group("research_question", [leaf("research_question", result.research_question.summary)]));
  if (result.method?.summary) groups.push(group("method", [leaf("method", result.method.summary)]));
  if (result.results?.summary) groups.push(group("results", [leaf("results", result.results.summary)]));
  if (result.limitations?.summary) groups.push(group("limitations", [leaf("limitations", result.limitations.summary)]));

  const hlKids = (result.highlights || []).map(h => leaf("highlight", h.title + (h.description ? "：" + h.description : "")));
  if (hlKids.length) groups.push(group("highlight", hlKids));

  return {
    label: clean(title),
    color: "#2f6fb3",
    children: groups.length ? groups : [{ label: "无可用结构", color: "#888", children: [] }],
  };
}

/** 布局：水平树，root 在左 */
export function layout(root: MNode): { width: number; height: number } {
  // 计算每个节点宽度
  const setW = (n: MNode) => {
    n.lines = wrap(n.label);
    n.w = Math.max(...n.lines.map(textWidth));
    n.h = Math.max(NODE_H, n.lines.length * 19 + 16);
    n.children.forEach(setW);
  };
  setW(root);

  // 每层的最大宽度 → 决定 x
  const levelW: number[] = [];
  const collect = (n: MNode, d: number) => {
    levelW[d] = Math.max(levelW[d] || 0, n.w || 0);
    n.children.forEach((c) => collect(c, d + 1));
  };
  collect(root, 0);
  const levelX: number[] = [MARGIN];
  for (let i = 1; i < levelW.length; i++) {
    levelX[i] = levelX[i - 1] + (levelW[i - 1] || 0) + GAP_X;
  }

  // Each subtree reserves enough height for both its own label and all children.
  const spans = new Map<MNode,number>();
  const measure = (n: MNode): number => {
    const children = n.children.reduce((sum,c)=>sum+measure(c),0) + Math.max(0,n.children.length-1)*GAP_Y;
    const span = Math.max(n.h || NODE_H, children);
    spans.set(n,span); return span;
  };
  const totalHeight = measure(root);
  const assign = (n: MNode, d: number, top: number) => {
    n.x = levelX[d];
    const span = spans.get(n)!;
    n.y = top + (span - (n.h || NODE_H))/2;
    const childrenHeight = n.children.reduce((sum,c)=>sum+spans.get(c)!,0) + Math.max(0,n.children.length-1)*GAP_Y;
    let y = top + (span-childrenHeight)/2;
    for (const c of n.children) { assign(c,d+1,y); y += spans.get(c)! + GAP_Y; }
  };
  assign(root, 0, MARGIN);

  const width = levelX[levelX.length - 1] + (levelW[levelW.length - 1] || 0) + MARGIN;
  const height = totalHeight + 2*MARGIN;
  return { width, height };
}

function hexToSoft(hex: string): string {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r},${g},${b},0.14)`;
}

function nodeSVG(n: MNode, isRoot: boolean): string {
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
    <text font-family='${FONT}' font-size="${FONT_SIZE}" font-weight="${isRoot ? 700 : 500}" fill="${textColor}">${lines.map((line,i)=>`<tspan x="${x+14}" y="${y+22+i*19}">${esc(line)}</tspan>`).join("")}</text>
  </g>`;
}

function edgeSVG(parent: MNode, child: MNode): string {
  const x1 = (parent.x || 0) + (parent.w || 0);
  const y1 = (parent.y || 0) + (parent.h || NODE_H) / 2;
  const x2 = child.x || 0;
  const y2 = (child.y || 0) + (child.h || NODE_H) / 2;
  const cx = (x1 + x2) / 2;
  const color = child.color || "#aaaaaa";
  return `<path d="M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="1.6" opacity="0.8"/>`;
}

function renderNode(n: MNode, isRoot: boolean): string {
  let s = nodeSVG(n, isRoot);
  for (const c of n.children) {
    s += edgeSVG(n, c) + renderNode(c, false);
  }
  return s;
}

export function renderSVG(root: MNode, width: number, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  ${renderNode(root, true)}
</svg>`;
}

export interface MindmapOutput {
  svg: string;
  width: number;
  height: number;
}

export function buildMindmap(result: SummaryResult, title: string): MindmapOutput {
  const root = buildTree(result, title);
  const { width, height } = layout(root);
  const svg = renderSVG(root, width, height);
  return { svg, width, height };
}

/** SVG → PNG dataURL（用主窗口 canvas，失败返回 null） */
export async function svgToPng(svg: string, width: number, height: number): Promise<string | null> {
  try {
    const win = Zotero.getMainWindow();
    if (!win) return null;
    const doc = win.document;
    const img = new win.Image();
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(()=>reject(new Error("SVG 图像加载超时")),10000);
      img.onload = () => { clearTimeout(timer); resolve(); };
      img.onerror = (e: unknown) => { clearTimeout(timer); reject(e); };
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

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1] || "";
  const bin = globalThis.atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export interface MindmapAttachment { title: string; url: string }
const MINDMAP_TAG = "PaperPilot Mindmap";
export function getMindmapAttachments(item: any): MindmapAttachment[] {
  const parent = item.isAttachment?.() ? item.parentItem : item;
  if (!parent?.getAttachments) return [];
  return parent.getAttachments().map((id:number)=>Zotero.Items.get(id))
    .filter((att:any)=>att && att.hasTag?.(MINDMAP_TAG) && !att.deleted)
    .map((att:any)=> {
      const library = Zotero.Libraries.get(att.libraryID);
      const path = library.libraryType === "group"
        ? `groups/${Zotero.Groups.getGroupIDFromLibraryID(att.libraryID)}` : "library";
      return {title:att.getField("title"),url:`zotero://select/${path}/items/${att.key}`};
    });
}

/** 保存思维导图为 SVG + PNG 附件（挂到条目下） */
export async function saveMindmap(item: any, out: MindmapOutput): Promise<{ svgSaved: boolean; pngSaved: boolean; paths: string[]; errors: string[] }> {
  const res = { svgSaved: false, pngSaved: false, paths:[] as string[], errors:[] as string[] };
  const parent = item.isAttachment && item.isAttachment() ? item.parentItem || item : item;
  if (!parent.isRegularItem?.()) throw new Error("请先为这个 PDF 创建文献条目，再生成思维导图");
  const tmpDir = Zotero.getTempDirectory ? Zotero.getTempDirectory().path : PathUtils.join(Zotero.DataDirectory.dir, "tmp");
  try {
    await IOUtils.makeDirectory(tmpDir, { ignoreExisting: true });
  } catch (e) {
    /* ignore */
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
      rename: false,
    });
    attachment.addTag(MINDMAP_TAG);
    await attachment.saveTx();
    res.svgSaved = true;
    if (attachment.getFilePathAsync) res.paths.push(await attachment.getFilePathAsync());
  } catch (e) {
    res.errors.push(String(e));
    Zotero.debug("[PaperPilot] SVG 附件保存失败: " + e);
  } finally {
    await IOUtils.remove(svgPath, {ignoreAbsent:true}).catch((e:unknown)=>Zotero.debug("[PaperPilot] 临时文件清理失败: "+e));
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
        rename: false,
      });
      attachment.addTag(MINDMAP_TAG);
      await attachment.saveTx();
      res.pngSaved = true;
      if (attachment.getFilePathAsync) res.paths.push(await attachment.getFilePathAsync());
    } catch (e) {
      res.errors.push(String(e));
      Zotero.debug("[PaperPilot] PNG 附件保存失败: " + e);
    } finally {
      await IOUtils.remove(pngPath, {ignoreAbsent:true}).catch((e:unknown)=>Zotero.debug("[PaperPilot] 临时文件清理失败: "+e));
    }
  }
  return res;
}

