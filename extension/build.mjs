import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: [
    "src/background.ts",
    "src/content.ts",
    "src/popup.ts",
    "src/options.ts",
  ],
  bundle: true,
  format: "esm",
  target: "chrome120",
  outdir: "dist",
  sourcemap: "inline",
  logLevel: "info",
};

function copyStatic() {
  mkdirSync("dist", { recursive: true });
  for (const f of ["manifest.json", "popup.html", "options.html"]) {
    cpSync(f, `dist/${f}`);
  }
}

if (watch) {
  const ctx = await esbuild.context(options);
  copyStatic();
  await ctx.watch();
} else {
  copyStatic();
  await esbuild.build(options);
}
