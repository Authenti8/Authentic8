export const evidenceSignatureAlgorithm = "Ed25519" as const;

export type SignedPayload<T> = {
  payload: T;
  signature: string;
  publicKeyId: string;
  algorithm: typeof evidenceSignatureAlgorithm;
};

export function isSha256Hex(value: string) {
  return /^[a-f0-9]{64}$/i.test(value);
}
