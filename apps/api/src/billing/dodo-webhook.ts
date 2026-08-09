import { createHmac, timingSafeEqual } from "node:crypto";
import { decodeDodoWebhookSecret } from "./dodo-secret.js";

type Headers = Record<string, string | string[] | undefined>;

export function verifyDodoWebhook(rawBody: Buffer, headers: Headers, secret: string) {
  if (!secret) return false;
  const id = dodoWebhookId(headers);
  const timestamp = header(headers, "webhook-timestamp");
  const supplied = header(headers, "webhook-signature");
  if (!id || !timestamp || !supplied || !fresh(timestamp)) return false;
  const key = decodeDodoWebhookSecret(secret);
  if (!key) return false;
  const payload = `${id}.${timestamp}.${rawBody.toString("utf8")}`;
  const expected = createHmac("sha256", key).update(payload).digest("base64");
  return supplied.split(" ").some((entry) => safeEqual(entry.split(",").at(-1), expected));
}

export function dodoWebhookId(headers: Headers) {
  return header(headers, "webhook-id");
}

function header(headers: Headers, name: string) {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function fresh(timestamp: string) {
  const seconds = Number(timestamp);
  return Number.isFinite(seconds) && Math.abs(Date.now() / 1000 - seconds) <= 300;
}

function safeEqual(candidate: string | undefined, expected: string) {
  if (!candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
