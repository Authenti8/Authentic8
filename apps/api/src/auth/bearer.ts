import { timingSafeEqual } from "node:crypto";

export function validBearerToken(authorization: string | undefined, secret: string) {
  const supplied = Buffer.from(authorization ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
