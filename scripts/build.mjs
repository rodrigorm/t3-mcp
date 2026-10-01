import { access, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";

// Prevent removed auth modules from surviving in a packed incremental build.
for (const file of await readdir(new URL("../dist/", import.meta.url)).catch(() => [])) {
  if (!/\.(js|d\.ts)$/.test(file)) continue;
  const source = file.replace(/\.(js|d\.ts)$/, ".ts");
  try { await access(new URL(`../src/${source}`, import.meta.url)); }
  catch { await rm(new URL(`../dist/${file}`, import.meta.url), { force: true }); }
}
const require = createRequire(import.meta.url);
const compiler = path.join(path.dirname(require.resolve("typescript/package.json")), "bin/tsc");
const result = spawnSync(process.execPath, [compiler], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
