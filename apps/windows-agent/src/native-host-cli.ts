import { enqueueBrowserEvidence } from "./browser-evidence-spool.js";

declare const __AUTHENTI8_AGENT_VERSION__: string;

const maximumMessageBytes = 64 * 1024;
let pending = Buffer.alloc(0);

process.stdin.on("data", (chunk: Buffer) => {
  pending = Buffer.concat([pending, chunk]);
  consumeFrames();
});
process.stdin.on("error", () => process.exit(1));

function consumeFrames() {
  while (pending.length >= 4) {
    const length = pending.readUInt32LE(0);
    if (length === 0 || length > maximumMessageBytes) process.exit(1);
    if (pending.length < length + 4) return;
    const body = pending.subarray(4, length + 4); pending = pending.subarray(length + 4);
    void respond(body);
  }
}

async function respond(body: Buffer) {
  try {
    const request = JSON.parse(body.toString("utf8")) as NativeRequest;
    if (request?.type === "BROWSER_EVIDENCE") {
      const accepted = await enqueueBrowserEvidence(request);
      return writeFrame({ ok: accepted, requestId: request.requestId,
        type: "AUTHENTI8_BROWSER_EVIDENCE", ...(accepted ? {} : { error: "INVALID_EVIDENCE" }) });
    }
    if (!request || !["PING", "STATUS"].includes(request.type ?? "")) {
      return writeFrame({ ok: false, requestId: request?.requestId, error: "UNSUPPORTED_MESSAGE" });
    }
    writeFrame({ ok: true, requestId: request.requestId, type: "AUTHENTI8_VERIFY_STATUS",
      installed: true, version: __AUTHENTI8_AGENT_VERSION__ });
  } catch { writeFrame({ ok: false, error: "INVALID_MESSAGE" }); }
}

function writeFrame(value: object) {
  const body = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length); process.stdout.write(Buffer.concat([header, body]));
}

type NativeRequest = { type?: string; requestId?: string; profileInstanceId?: string;
  extensionRuntimeId?: string; activeProfileVerified?: boolean; evidence?: unknown };
