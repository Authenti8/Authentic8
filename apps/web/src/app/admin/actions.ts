"use server";

import { revalidatePath } from "next/cache";
import { postServerApi, requireSession } from "@/lib/server-api";

export async function updateDispute(formData: FormData) {
  await requireSession();
  const disputeId = String(formData.get("disputeId") ?? "");
  const status = String(formData.get("status") ?? "");
  const resolution = String(formData.get("resolution") ?? "").trim().slice(0, 1000);
  if (!/^[0-9a-f-]{36}$/i.test(disputeId) || !["REVIEWED", "RESOLVED"].includes(status)) {
    throw new Error("Invalid dispute update.");
  }
  if (status === "RESOLVED" && resolution.length < 10) {
    throw new Error("A resolution of at least 10 characters is required.");
  }
  await postServerApi("/admin/disputes/resolve", { disputeId, status, resolution });
  revalidatePath("/admin");
}

export async function requestAdminChange(formData: FormData) {
  await requireSession();
  const action = String(formData.get("action") ?? "");
  const targetId = String(formData.get("targetId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 1000);
  if (!isUuid(targetId) || !["DISABLE_RULE", "REFUND_CREDITS"].includes(action)
      || reason.length < 10) throw new Error("A valid target and reason are required.");
  const payload: Record<string, unknown> = {};
  if (action === "REFUND_CREDITS") {
    const amount = Number(formData.get("amount"));
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 999999) {
      throw new Error("Refund credits must be between 1 and 999999.");
    }
    payload.amount = amount;
  }
  await postServerApi("/admin/changes", { action, targetId, reason, payload });
  revalidatePath("/admin");
}

export async function approveAdminChange(formData: FormData) {
  await requireSession();
  const requestId = String(formData.get("requestId") ?? "");
  if (!isUuid(requestId)) throw new Error("Invalid administrative change request.");
  await postServerApi("/admin/changes/approve", { requestId });
  revalidatePath("/admin");
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}
