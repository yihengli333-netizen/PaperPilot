import * as esbuild from "esbuild";
import { existsSync, mkdirSync, statSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(__dirname, "addon/chrome/content/scripts");
const version = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")).version;
const manifest = JSON.parse(readFileSync(resolve(__dirname, "addon/manifest.json"), "utf8"));
if (manifest.version !== version) throw new Error("package.json 与 manifest.json 版本不一致");
const watch = process.argv.includes("--watch");

const options = {
  entryPoints: [
    resolve(__dirname, "src/index.ts"),
    resolve(__dirname, "src/settings.ts"),
  ],
  bundle: true,
  outdir,
  target: "firefox102",
  format: "iife",
  platform: "browser",
  sourcemap: false,
  logLevel: "info",
  legalComments: "none",
  charset: "utf8",
  define: { __PP_VERSION__: JSON.stringify(version) },
};

if (!existsSync(outdir)) mkdirSync(outdir, { recursive: true });

async function report() {
  for (const name of ["index.js", "settings.js"]) {
    const p = resolve(outdir, name);
    if (existsSync(p)) {
      console.log(`[PaperPilot] ${name} -> ${(statSync(p).size / 1024).toFixed(1)} KB`);
    }
  }
}

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[PaperPilot] watching...");
} else {
  await esbuild.build(options);
  await report();
  console.log(`[PaperPilot] v${version} 构建完成`);
}
