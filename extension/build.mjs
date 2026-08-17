import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readFileSync } from "node:fs";

const watch = process.argv.includes("--watch");

const shared = {
  bundle: true,
  target: "chrome120",
  outdir: "dist",
  sourcemap: "inline",
  logLevel: "info",
};

// Content script chạy như classic script — KHÔNG được chứa import/export,
// nếu không Chrome báo SyntaxError và cả script không chạy (mất nút ＋Q).
// pagehook chạy ở MAIN world nhưng vẫn là content script → cũng phải classic.
const contentConfig = { ...shared, entryPoints: ["src/content.ts", "src/pagehook.ts"], format: "iife" };

// Service worker (manifest "type": "module") và popup/options (<script type="module">)
// đều nạp dưới dạng ES module nên giữ format esm.
const moduleConfig = {
  ...shared,
  entryPoints: ["src/background.ts", "src/popup.ts", "src/options.ts"],
  format: "esm",
};

function copyStatic() {
  mkdirSync("dist", { recursive: true });
  for (const f of ["manifest.json", "popup.html", "options.html"]) {
    cpSync(f, `dist/${f}`);
  }
}

if (watch) {
  const ctxs = await Promise.all([esbuild.context(contentConfig), esbuild.context(moduleConfig)]);
  copyStatic();
  await Promise.all(ctxs.map((c) => c.watch()));
} else {
  copyStatic();
  await Promise.all([esbuild.build(contentConfig), esbuild.build(moduleConfig)]);
  assertContentIsClassic();
}

/** Chốt chặn: một `export` lọt vào content.js là cả script chết câm (mất nút ＋Q). */
function assertContentIsClassic() {
  for (const file of ["dist/content.js", "dist/pagehook.js"]) {
    const code = readFileSync(file, "utf8").split("//# sourceMappingURL=")[0];
    const bad = code.match(/^\s*(export|import)\s/m);
    if (bad) {
      throw new Error(
        `${file} chứa "${bad[1]}" ở cấp cao nhất — content script là classic script, ` +
          `Chrome sẽ báo SyntaxError và không chạy gì cả. Bỏ từ khoá export/import trong file nguồn.`,
      );
    }
  }
  console.log("✓ content.js + pagehook.js là classic script (không có export/import)");
}
