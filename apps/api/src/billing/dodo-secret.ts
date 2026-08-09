const prefix = "whsec_";
const base64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function decodeDodoWebhookSecret(secret: string) {
  if (!secret.startsWith(prefix)) return null;
  const encoded = secret.slice(prefix.length);
  if (!base64.test(encoded) || encoded.length % 4 === 1) return null;
  const decoded = Buffer.from(encoded, "base64");
  const canonical = decoded.toString("base64").replace(/=+$/, "");
  const supplied = encoded.replace(/=+$/, "");
  return decoded.length >= 32 && canonical === supplied ? decoded : null;
}
