import { decryptMailToken, encryptMailToken } from "../auth/mail-crypto.js";

export function encryptIntegrationToken(key: Buffer, token: string, integrationId: string) {
  return JSON.stringify(encryptMailToken(key, token, `integration:${integrationId}`));
}

export function decryptIntegrationToken(key: Buffer, value: string, integrationId: string) {
  const parsed = JSON.parse(value) as {
    ciphertext: string;
    initializationVector: string;
    authenticationTag: string;
  };
  return decryptMailToken(key, parsed, `integration:${integrationId}`);
}

