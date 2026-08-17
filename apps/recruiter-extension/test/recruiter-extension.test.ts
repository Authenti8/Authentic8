import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { latestSequence, mergeLogs, parseMeetCode, validRecruiterApiPath,
  type RecruiterLog } from "../src/index.js";

test("only canonical Google Meet URLs produce a meeting code", () => {
  assert.equal(parseMeetCode("https://meet.google.com/abc-defg-hij"), "abc-defg-hij");
  assert.equal(parseMeetCode("https://evil.example/abc-defg-hij"), undefined);
  assert.equal(parseMeetCode("https://meet.google.com/not-a-code"), undefined);
});

test("reconnection merges ordered events, ignores duplicates, and rejects malformed logs", () => {
  const event = (sequence: number): RecruiterLog => ({ sequence, kind: "MONITORING_ACTIVE",
    message: `event ${sequence}`, occurredAt: `2026-08-14T10:00:0${sequence}Z`, metadata: {} });
  const merged = mergeLogs([event(2)], [event(1), event(2), { ...event(3), occurredAt: "bad" }]);
  assert.deepEqual(merged.map((item) => item.sequence), [1, 2]);
});

test("delayed events render chronologically without moving the resume cursor backwards", () => {
  const event = (sequence: number, occurredAt: string): RecruiterLog => ({ sequence,
    kind: "MONITORING_ACTIVE", message: `event ${sequence}`, occurredAt, metadata: {} });
  const logs = mergeLogs([event(10, "2026-08-14T10:10:00Z")],
    [event(11, "2026-08-14T10:00:00Z")]);
  assert.deepEqual(logs.map((item) => item.sequence), [11, 10]);
  assert.equal(latestSequence(logs), 11);
});

test("the manifest content entry has no module dependency at runtime", () => {
  const compiled = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
  assert.doesNotMatch(compiled, /^\s*(?:import|export)\s/m);
  assert.doesNotMatch(compiled, /if \(meeting\.protected && meeting\.interviewId\) return meeting;\s*return/);
});

test("the background continuously refreshes its short-lived credential", () => {
  const compiled = readFileSync(new URL("../src/background.js", import.meta.url), "utf8");
  assert.match(compiled, /alarms\.create\("authenti8-token-refresh"/);
  assert.match(compiled, /\/recruiter-extension\/token\/refresh/);
  assert.match(compiled, /streamError: true,[\s\S]*status:/);
});

test("authorization failures clear prior logs instead of leaving a stale panel", () => {
  const compiled = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
  assert.match(compiled, /authorizationFailure\(error\)[\s\S]*panel\.remove\(\)/);
});

test("the live overlay is draggable, persistent, click-through, and animates additions", () => {
  const compiled = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
  assert.match(compiled, /authenti8:recruiter-panel-state/);
  assert.match(compiled, /aria-live=\"polite\"/);
  assert.match(compiled, /pointer-events:none/);
  assert.match(compiled, /@keyframes log-enter/);
  assert.match(compiled, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(compiled, /replaceChildren\(\.\.\.logs\.map/);
  assert.doesNotMatch(compiled, /(?:candidate|li)\{[^}]*pointer-events:auto/);
  assert.match(compiled, /main\.hidden = minimized;[\s\S]*positionPanel\(panel, bounds\.left, bounds\.top\)/);
  assert.match(compiled, /minimized: panel\.classList\.contains\("minimized"\)/);
  const persistence = compiled.slice(compiled.indexOf("async function persistPanelState"),
    compiled.indexOf("async function restorePanelState"));
  assert.doesNotMatch(persistence, /storage\.local\.get/);
});

test("the background proxy accepts only recruiter read endpoints", () => {
  assert.equal(validRecruiterApiPath("/recruiter-extension/meetings/abc-defg-hij"), true);
  assert.equal(validRecruiterApiPath(
    "/recruiter-extension/interviews/123e4567-e89b-12d3-a456-426614174000/logs?after=42"), true);
  assert.equal(validRecruiterApiPath(
    "/recruiter-extension/interviews/123e4567-e89b-12d3-a456-426614174000/events?after=42"), true);
  assert.equal(validRecruiterApiPath("/billing/checkout"), false);
  assert.equal(validRecruiterApiPath("/recruiter-extension/interviews/not-a-uuid/logs?after=0"), false);
});
