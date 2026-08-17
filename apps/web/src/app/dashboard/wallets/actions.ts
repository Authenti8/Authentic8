"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { postServerApi, requireSession } from "@/lib/server-api";

export async function adjustWallet(formData: FormData) {
  await requireSession();
  const memberUserId = String(formData.get("memberUserId") ?? "");
  const operation = String(formData.get("operation") ?? "");
  const quantity = Number(formData.get("quantity"));
  const reason = String(formData.get("reason") ?? "").trim();
  if (!uuid(memberUserId) || !["GRANT", "REDUCE"].includes(operation)
      || !Number.isInteger(quantity) || quantity < 1 || quantity > 100000 || reason.length < 10) {
    throw new Error("Invalid wallet adjustment.");
  }
  await postServerApi("/organization/members/wallets", {
    memberUserId, operation, quantity, reason, idempotencyKey: randomUUID(),
  });
  revalidatePath("/dashboard/wallets");
}

export async function manageBillingGrant(formData: FormData) {
  await requireSession();
  const managerUserId = String(formData.get("managerUserId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  const revoke = formData.get("revoke") === "true";
  const expiresAt = optional(String(formData.get("expiresAt") ?? ""));
  const perPurchaseLimitMinor = optionalNumber(formData.get("perPurchaseLimitMinor"));
  const monthlyLimitMinor = optionalNumber(formData.get("monthlyLimitMinor"));
  if (!uuid(managerUserId) || reason.length < 10) throw new Error("Invalid billing grant.");
  await postServerApi("/organization/members/billing-grants", {
    managerUserId, reason, revoke: revoke || undefined,
    expiresAt,
    perPurchaseLimitMinor, monthlyLimitMinor,
  });
  revalidatePath("/dashboard/wallets");
}

function optional(value: string) { return value || undefined; }
function optionalNumber(value: FormDataEntryValue | null) {
  if (!value) return undefined; const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Invalid billing limit.");
  return number;
}
function uuid(value: string) { return /^[0-9a-f-]{36}$/i.test(value); }
