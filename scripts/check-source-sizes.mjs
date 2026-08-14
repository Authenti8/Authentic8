import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const sourceExtensions = /\.(?:[cm]?[jt]sx?|css|sql|sh|swift)$/;
const result = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
);

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const oversized = result.stdout
  .split("\0")
  .filter((file) => file && sourceExtensions.test(file) && existsSync(file))
  .map((file) => ({ file, lines: readFileSync(file, "utf8").split("\n").length }))
  .filter(({ lines }) => lines > 500);

const overFunctional = result.stdout
  .split("\0")
  .filter((file) => file && sourceExtensions.test(file) && existsSync(file))
  .map((file) => ({ file, functions: functionCount(file, readFileSync(file, "utf8")) }))
  .filter(({ functions }) => functions > 50);

if (oversized.length > 0) {
  for (const { file, lines } of oversized) {
    console.error(`[guardian] ${file} has ${lines} lines (maximum: 500).`);
  }
  process.exit(1);
}

if (overFunctional.length > 0) {
  for (const { file, functions } of overFunctional) {
    console.error(`[guardian] ${file} has ${functions} functions (maximum: 50).`);
  }
  process.exit(1);
}

console.log("[guardian] Authored source files are within the 500-line and 50-function limits.");

function functionCount(file, source) {
  if (file.endsWith(".swift")) return (source.match(/\bfunc\s+\w+\s*\(/g) ?? []).length;
  if (file.endsWith(".sql")) {
    return (source.match(/\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/gi) ?? []).length;
  }
  if (file.endsWith(".sh")) return (source.match(/^\s*[A-Za-z_]\w*\s*\(\)\s*\{/gm) ?? []).length;
  if (!/\.[cm]?[jt]sx?$/.test(file)) return 0;
  const kind = file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const root = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, kind);
  let count = 0;
  const visit = (node) => {
    if (ts.isFunctionLike(node) && node.body) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(root);
  return count;
}
