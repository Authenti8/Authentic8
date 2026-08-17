"use server";

import { revalidatePath } from "next/cache";
import { postServerApi, requireSession } from "@/lib/server-api";

export async function updateCommercialLead(formData: FormData) {
  await requireSession();
  const leadId = String(formData.get("leadId") ?? "");
  const stage = String(formData.get("stage") ?? "");
  const assignedTo = String(formData.get("assignedTo") ?? "");
  const note = String(formData.get("note") ?? "").trim().slice(0, 2000);
  const followUpLocal = String(formData.get("followUpDueAt") ?? "");
  const followUpDueAt = followUpLocal ? `${followUpLocal}:00Z` : undefined;
  const completeFollowUp = formData.get("completeFollowUp") === "true";
  if (!uuid(leadId) || (assignedTo && !uuid(assignedTo))) throw new Error("Invalid lead update.");
  await postServerApi("/commercial/leads/update", {
    leadId, stage: stage || undefined, assignedTo: assignedTo || undefined,
    note: note || undefined, followUpDueAt, completeFollowUp: completeFollowUp || undefined,
  });
  revalidateCommercial();
}

export async function manageSalesStaff(formData: FormData) {
  await requireSession();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "");
  const status = String(formData.get("status") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!email || !["PLATFORM_FOUNDER", "PLATFORM_SALES"].includes(role)
      || !["ACTIVE", "SUSPENDED", "REMOVED"].includes(status) || reason.length < 10) {
    throw new Error("Invalid staff update.");
  }
  await postServerApi("/commercial/staff", { email, role, status, reason });
  revalidateCommercial();
}

export async function convertCommercialLead(formData: FormData) {
  await requireSession();
  const leadId = String(formData.get("leadId") ?? "");
  const organizationId = String(formData.get("organizationId") ?? "");
  if (!uuid(leadId) || !uuid(organizationId)) throw new Error("Invalid lead conversion.");
  await postServerApi("/commercial/leads/convert", { leadId, organizationId });
  revalidateCommercial();
}

function revalidateCommercial() {
  revalidatePath("/commercial");
  revalidatePath("/admin/commercial");
}

function uuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}
