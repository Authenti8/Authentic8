import { readFileSync } from "node:fs";

const content = readFileSync(new URL("../dist/content.js", import.meta.url), "utf8");
if (/^\s*(?:import|export)\s/m.test(content)) {
  throw new Error("Recruiter content script must be a self-contained classic script.");
}
