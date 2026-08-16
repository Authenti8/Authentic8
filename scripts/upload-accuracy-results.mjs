import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const origin = required("AUTHENTI8_API_ORIGIN").replace(/\/$/, "");
const secret = required("ACCURACY_UPLOAD_SECRET");
const document = JSON.parse(readFileSync("accuracy-results.json", "utf8"));
if (!Array.isArray(document.results) || !document.results.length) fail("No accuracy results found.");
await uploadRelease(document.results);

async function uploadRelease(results) {
  const payload = JSON.stringify({ results });
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  const response = await fetch(`${origin}/api/v1/internal/operations/accuracy-release`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}`,
      "x-authenti8-signature": `sha256=${signature}` }, body: payload,
  });
  if (!response.ok) fail(`Accuracy release failed with HTTP ${response.status}.`);
  const body = await response.json();
  if (!body.released) fail(`Accuracy release was rejected: ${body.reason ?? "unknown"}.`);
  console.log(`Atomically released ${results.map((item) => item.platform).join(" and ")}.`);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required.`);
  return value;
}

function fail(message) { console.error(message); process.exit(1); }
