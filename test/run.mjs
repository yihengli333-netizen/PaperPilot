/**
 * 纯函数冒烟测试（不依赖 Zotero 环境）
 * 运行：node test/run.mjs
 */
import * as esbuild from "esbuild";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rmSync, writeFileSync } from "node:fs";

// 输出同时写入 UTF-8 报告文件（避免终端编码导致中文乱码）
const __report = [];
const _log = console.log.bind(console);
console.log = (...a) => {
  const s = a.join(" ");
  __report.push(s);
  _log(s);
};
process.on("exit", () => {
  try {
    writeFileSync(resolve(__dirname, "test-report.txt"), __report.join("\n"), "utf8");
  } catch (e) {
    /* ignore */
  }
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(__dirname, ".tmp-pure.cjs");

await esbuild.build({
  entryPoints: [resolve(__dirname, "pure.ts")],
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

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

console.log("\n[1] JSON 提取");
check("纯 JSON", m.extractJSON('{"a":1}').a === 1);
check("markdown 代码块包裹", m.extractJSON('```json\n{"a":2}\n```').a === 2);
check("前后有多余文字", m.extractJSON('好的：\n{"a":3}\n以上').a === 3);
check("截断可修补", m.extractJSON('{"a":4, "b":"xx').a === 4);
let threw = false;
try {
  m.extractJSON("这不是 JSON");
} catch (e) {
  threw = true;
}
check("非 JSON 抛错", threw);

console.log("\n[2] 长文截断");
const long = "A".repeat(1000) + "B".repeat(1000);
const t1 = m.truncateText(long, 5000);
check("未超长不截断", t1.truncated === false && t1.text === long);
const t2 = m.truncateText(long, 400);
check("超长被截断", t2.truncated === true && t2.text.includes("[...中间部分已省略...]"));
check("截断保留首尾", t2.text.startsWith("AAAA") && t2.text.endsWith("BBBB"));

console.log("\n[3] 引用片段校验");
const full = "We propose a flexible sensor array that achieves 98% accuracy on the test set.";
check("完全匹配", m.verifyQuote(full, "flexible sensor array") === true);
check("空白差异仍匹配", m.verifyQuote(full, "flexible   sensor\narray") === true);
check("大小写不敏感", m.verifyQuote(full, "FLEXIBLE SENSOR ARRAY") === true);
check("不存在片段", m.verifyQuote(full, "quantum computing model") === false);
check("过短片段判否", m.verifyQuote(full, "abc") === false);

console.log("\n[4] 页码解析");
check("Page 5", m.parsePage("Section 3.2, Page 5") === 5);
check("p.7", m.parsePage("Sec. 2, p.7") === 7);
check("第 12 页", m.parsePage("第 12 页") === 12);
check("无页码", m.parsePage("Section 3.2") === 0);
check("异常大页码过滤", m.parsePage("Page 99999") === 0);

console.log("\n[5] 结果规整");
const raw = {
  research_question: { summary: "问题A", location: "Page 1", quote: "We propose" },
  method: {},
  results: null,
  limitations: { summary: "局限D", location: "Page 8", quote: "limitation is that" },
  highlights: [{ title: "假设", description: "看假设", location: "Page 4", quote: "we assume" }],
};
const norm = m.normalizeResult(raw, "test-model");
check("缺字段补默认值", norm.method.summary.includes("未在正文中找到"));
check("null 字段不崩溃", norm.results && typeof norm.results.summary === "string");
check("highlights 保留", norm.highlights.length === 1);
check("meta 写入模型", norm.meta.model === "test-model");
check("highlights 上限 12", m.normalizeResult({ highlights: Array(30).fill({ title: "x" }) }, "m").highlights.length === 12);

console.log("\n[6] Markdown 输出");
const md = m.toMarkdown(norm, "测试论文");
check("含标题", md.includes("# 测试论文"));
check("含四个结论", ["研究问题", "核心方法", "主要结果", "作者承认的局限"].every((s) => md.includes(s)));
check("含关注点", md.includes("建议重点关注") && md.includes("假设"));
check("含我的理解区块", md.includes("我的理解与疑问"));

console.log("\n[7] 按章节压缩长文");
const sec = (title, ch, n) => `${title}\n${ch.repeat(n)}\n`;
const paper = sec("Abstract", "a", 500) + sec("1 Introduction", "i", 3000) + sec("2 Related Work", "w", 6000)
  + sec("3 Method", "m", 8000) + sec("3.1 Encoder", "e", 2000) + sec("4 Experiments", "x", 8000)
  + sec("5 Conclusion", "c", 800) + sec("References", "r", 9000) + sec("Appendix A", "p", 5000);
check("识别章节（子章节并入父章节）", m.splitSections(paper).map((s) => s.kind).join(",") === "abstract,introduction,related,method,results,conclusion,references,appendix");
const c1 = m.condenseText(paper, 40000);
check("丢弃参考文献和附录后放得下则不截正文", c1.truncated && !c1.partial && !c1.text.includes("rrrr") && !c1.text.includes("pppp") && c1.text.includes("e".repeat(2000)));
check("记录被丢弃的章节", c1.omitted.join(",") === "references,appendix");
const c2 = m.condenseText(paper, 15000);
check("总长度不超过上限", c2.text.length <= 15000, String(c2.text.length));
check("每个保留章节都有内容", ["Abstract", "Introduction", "Related Work", "Method", "Experiments", "Conclusion"].every((h) => c2.text.includes(h)));
check("短的高优先级章节完整保留", c2.text.includes("c".repeat(800)) && c2.text.includes("a".repeat(500)));
check("方法与实验比相关工作分到更多", (c2.text.match(/m/g) || []).length > 2 * (c2.text.match(/w/g) || []).length);
check("方法、实验中段不再整体丢失", (c2.text.match(/x/g) || []).length > 2000);
check("无章节结构时退回首尾截断", m.condenseText("A".repeat(1000) + "B".repeat(1000), 400).text.includes("[...中间部分已省略...]"));
check("中文章节标题", m.splitSections(sec("摘要", "a", 10) + sec("1 引言", "b", 10) + sec("2 方法", "c", 10) + sec("参考文献", "d", 10)).length === 4);

console.log("\n[8] 引用匹配（规范化与模糊匹配）");
const pdfText = "Our model uses a ﬁxed-point solver. We show that the meth-\nod reduces error by 12% on the “held-out” set.\nOther text follows here.";
check("连字 ﬁ", m.verifyQuote(pdfText, "uses a fixed-point solver") === true);
check("行末连字符断词", m.verifyQuote(pdfText, "the method reduces error by 12%") === true);
check("弯引号与直引号", m.verifyQuote(pdfText, 'on the "held-out" set') === true);
check("连字符有无均可", m.verifyQuote(pdfText, "uses a fixedpoint solver") === true);
const fuzzy = m.matchQuote(pdfText, "We show that this method reduces error by 12% on the held-out set");
check("个别字词差异 → 模糊命中", fuzzy && !fuzzy.exact && fuzzy.similarity >= 0.9, JSON.stringify(fuzzy));
check("模糊命中返回原文片段", fuzzy && fuzzy.text.includes("the method reduces error by 12%") && m.verifyQuote(pdfText, fuzzy.text), fuzzy && fuzzy.text);
check("改动过多不接受", m.matchQuote(pdfText, "We prove that the approach increases accuracy by 40% on all sets.") === null);
check("关键句被改写的结尾不接受", m.matchQuote("this is a sufficiently long original prefix and true ending", "this is a sufficiently long original prefix and invented ending") === null);
check("短引用不做模糊匹配", m.matchQuote(pdfText, "fixed-pont solver") === null);
check("精确匹配标记为 exact", m.matchQuote(pdfText, "Other text follows")?.exact === true);
const big = "lorem ipsum dolor sit amet ".repeat(4000) + "The quick brown fox jumps over the lazy dog near the river bank." + " consectetur adipiscing elit".repeat(4000);
const t0 = Date.now();
const bigHit = m.matchQuote(big, "The quick brown fox jumped over the lazy dog near the river bank.");
check("长文模糊匹配足够快且正确", bigHit && bigHit.text.startsWith("The quick brown fox jumps") && Date.now() - t0 < 1000, `${Date.now() - t0}ms`);

console.log("\n[9] 补充证据与校验");
const withEv = m.normalizeResult({ method: { summary: "M", quote: "q1", evidence: [{ summary: "E1", quote: "q2" }, { summary: "dup", quote: "q1" }, { summary: "E3", quote: "q3" }, { summary: "E4", quote: "q4" }] } }, "m");
check("evidence 去重且最多 2 条", withEv.method.evidence.map((e) => e.quote).join() === "q2,q3");
check("无 evidence 时不产生空数组", !("evidence" in withEv.results));
check("allFindings 含主结论、证据、关注点", m.allFindings({ ...withEv, highlights: [{ title: "h", quote: "x" }] }).length === 4 + 2 + 1);
const pages = [{ index: 0, text: "Intro text only." }, { index: 1, text: "We show that the meth-\nod reduces error by 12% on the test set." }];
const pp = m.postProcess(m.normalizeResult({
  method: { summary: "M", location: "Page 9", quote: "We show that this method reduces the error by 12% on the test set.",
    evidence: [{ summary: "E", location: "", quote: "an invented sentence that is not in the paper at all" }] },
}, "m"), pages.map((p) => p.text).join("\n"), pages);
check("模糊命中后已校验并替换为原文", pp.method.verified && pp.method.corrected && pp.method.quote.startsWith("We show that the meth"));
check("页码按原文逐页匹配", pp.method.page === 2 && pp.method.location === "PDF 第 2 页");
check("补充证据同样校验", pp.method.evidence[0].verified === false);
const md2 = m.toMarkdown(pp, "t");
check("Markdown 含补充证据", md2.includes("补充：E"));
const cross = m.postProcess(m.normalizeResult({ method: { summary: "M", quote: "end of page one text [PDF Page 2] start of page two" } }, "m"),
  "[PDF Page 1]\nend of page one text\n\n[PDF Page 2]\nstart of page two", undefined);
check("跨页片段不算校验通过", cross.method.verified === false);

rmSync(outfile, { force: true });

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
