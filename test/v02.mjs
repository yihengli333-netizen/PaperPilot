/**
 * v0.2.0 新功能测试：思维导图（树/布局/SVG）、类别配色、导读笔记、坐标降级。
 * 运行：node test/v02.mjs
 */
import * as esbuild from "esbuild";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(__dirname, ".tmp-v02.cjs");

await esbuild.build({
  entryPoints: [resolve(__dirname, "v02-entry.ts")],
  bundle: true,
  outfile,
  format: "cjs",
  platform: "node",
  target: "node18",
  logLevel: "silent",
  define: { __PP_VERSION__: JSON.stringify("test") },
});

const require = createRequire(import.meta.url);
const m = require(outfile);

const report = [];
const _log = console.log.bind(console);
console.log = (...a) => {
  const s = a.join(" ");
  report.push(s);
  _log(s);
};
process.on("exit", () => {
  try { writeFileSync(resolve(__dirname, "v02-report.txt"), report.join("\n"), "utf8"); } catch (e) {}
});

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

const RESULT = {
  research_question: { summary: "研究长期稳定性策略", location: "Page 1", quote: "long-term stability", page: 1, verified: true },
  method: { summary: "综述柔性神经电极方案", location: "Page 2", quote: "flexible neural interface", page: 2, verified: true },
  results: { summary: "归纳三类封装路径", location: "Page 5", quote: "encapsulation", page: 5, verified: true },
  limitations: { summary: "缺少长期体内数据", location: "Page 9", quote: "limited in vivo", page: 9, verified: true },
  highlights: [
    { title: "材料选择", description: "对比 PI 与 Parylene", location: "Page 4", quote: "polyimide", page: 4, verified: true },
    { title: "炎症响应", description: "炎症是失效主因", location: "Page 6", quote: "inflammatory", page: 6, verified: true },
  ],
  meta: { model: "test", createdAt: 1700000000000 },
};

console.log("\n[1] 类别配色");
check("五类颜色齐全", Object.keys(m.CATEGORY_COLOR).length === 5);
check("研究问题=黄", m.CATEGORY_COLOR.research_question === "#ffd400");
check("疑点=红", m.CATEGORY_COLOR.limitations === "#ff6666");
check("建议关注=橙", m.CATEGORY_COLOR.highlight === "#f19837");
check("五类标签齐全", Object.keys(m.CATEGORY_LABEL).length === 5);

console.log("\n[2] 思维导图树构建");
const tree = m.buildTree(RESULT, "长期稳定性综述");
check("根=论文标题", tree.label.includes("长期稳定性"));
check("根有 5 个分类", tree.children.length === 5);
check("建议关注含 2 条", tree.children.find((c) => c.label.includes("建议关注")).children.length === 2);
check("叶子带类别色", tree.children[0].children[0].color === "#ffd400");
const longTitle = m.buildTree(RESULT, "A".repeat(50));
check("完整保留长标题并换行显示", longTitle.label === "A".repeat(50));

console.log("\n[3] 思维导图布局");
const root = m.buildTree(RESULT, "T");
const { width, height } = m.layout(root);
check("尺寸为正", width > 0 && height > 0);
const leaves = [];
const collectLeaves = (n) => { if (!n.children.length) leaves.push(n); n.children.forEach(collectLeaves); };
collectLeaves(root);
const ys = leaves.map((l) => l.y).sort((a, b) => a - b);
let noOverlap = true;
for (let i = 1; i < ys.length; i++) if (ys[i] - ys[i - 1] < 30) noOverlap = false;
check("叶子节点不重叠", noOverlap, JSON.stringify(ys));
check("子节点 x 大于父节点", root.children.every((c) => c.x > root.x));

console.log("\n[4] SVG 渲染");
const svg = m.renderSVG(root, width, height);
check("是合法 SVG 包裹", svg.startsWith("<svg") && svg.includes("</svg>"));
check("含根节点文本", svg.includes("长期稳定性") || svg.includes("T<"));
check("含连线", svg.includes("<path"));
check("含节点矩形", svg.includes("<rect"));
const out = m.buildMindmap(RESULT, "Demo");
check("buildMindmap 一体化", out.svg.startsWith("<svg") && out.width > 0);

console.log("\n[5] 导读笔记");
const guide = m.buildGuideNote(RESULT, "测试论文", { mindmapSaved: true });
check("含颜色图例", guide.includes("颜色图例") && guide.includes("#ffd400"));
check("含思维导图块", guide.includes("思维导图") && guide.includes("附件"));
check("含大纲四个结论", ["研究问题", "核心方法", "主要结果", "作者承认的局限"].every((s) => guide.includes(s)));
check("含建议关注", guide.includes("建议重点关注") && guide.includes("材料选择"));
check("含页码", guide.includes("第 1 页"));
check("含用户书写区", guide.includes("我的理解与疑问"));

rmSync(outfile, { force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
