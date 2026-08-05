import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type EncryptedToken = {
  ciphertext: string;
  initializationVector: string;
  authenticationTag: string;
};

export function encryptMailToken(key: Buffer, token: string, context: string): EncryptedToken {
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, initializationVector);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return {
    ciphertext: encrypted.toString("base64"),
    initializationVector: initializationVector.toString("base64"),
    authenticationTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptMailToken(
  key: Buffer,
  encrypted: EncryptedToken,
  context: string,
) {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(encrypted.initializationVector, "base64"),
  );
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(encrypted.authenticationTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
