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

rmSync(outfile, { force: true });

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
