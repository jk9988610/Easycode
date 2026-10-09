import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

const shared = {
  bundle: true,
  platform: "node",
  target: "node18",
  sourcemap: true,
  external: ["electron", "iconv-lite", "jschardet", "adm-zip", "@homebridge/node-pty-prebuilt-multiarch"],
  logLevel: "info",
};

async function run() {
  const mainCtx = await esbuild.context({
    ...shared,
    entryPoints: [path.join(__dirname, "../src/main/index.ts")],
    outfile: path.join(__dirname, "../dist-electron/index.js"),
    format: "esm",
  });

  const preloadCtx = await esbuild.context({
    ...shared,
    entryPoints: [path.join(__dirname, "../src/preload/preload.ts")],
    outfile: path.join(__dirname, "../dist-electron/preload.cjs"),
    format: "cjs",
  });

  if (watch) {
    await Promise.all([mainCtx.watch(), preloadCtx.watch()]);
    console.log('[electron-build] watching...');
  } else {
    await Promise.all([mainCtx.rebuild(), preloadCtx.rebuild()]);
    await mainCtx.dispose();
    await preloadCtx.dispose();
    console.log("[electron-build] done");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
