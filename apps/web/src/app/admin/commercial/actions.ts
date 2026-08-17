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

export async function saveEnterpriseProposal(formData: FormData) {
  await requireSession();
  const input = {
    leadId: String(formData.get("leadId") ?? ""),
    organizationId: String(formData.get("organizationId") ?? ""),
    contractValueMinor: Number(formData.get("contractValueMinor")),
    currency: String(formData.get("currency") ?? "").trim().toUpperCase(),
    billingInterval: String(formData.get("billingInterval") ?? ""),
    purchasedCredits: Number(formData.get("purchasedCredits")),
    effectiveAt: `${String(formData.get("effectiveAt") ?? "")}:00Z`,
    expiresAt: formData.get("expiresAt") ? `${String(formData.get("expiresAt"))}:00Z` : undefined,
    paymentTermsDays: Number(formData.get("paymentTermsDays")),
    signedDocumentReference: String(formData.get("signedDocumentReference") ?? "").trim() || undefined,
  };
  if (!uuid(input.leadId) || !uuid(input.organizationId) || !Number.isSafeInteger(
    input.contractValueMinor) || input.contractValueMinor < 1 || !/^[A-Z]{3}$/.test(input.currency)
      || !["MONTHLY", "ANNUAL", "ONE_TIME"].includes(input.billingInterval)
      || !Number.isInteger(input.purchasedCredits) || input.purchasedCredits < 1) {
    throw new Error("Invalid enterprise proposal.");
  }
  await postServerApi("/commercial/enterprise/proposal", input);
  revalidateCommercial();
}

export async function issueEnterpriseInvoice(formData: FormData) {
  await requireSession();
  const agreementId = String(formData.get("agreementId") ?? "");
  const provider = String(formData.get("provider") ?? "").trim();
  const providerInvoiceId = String(formData.get("providerInvoiceId") ?? "").trim();
  const signedDocumentReference = String(formData.get("signedDocumentReference") ?? "").trim();
  const dueAt = `${String(formData.get("dueAt") ?? "")}:00Z`;
  if (!uuid(agreementId) || provider.length < 2 || providerInvoiceId.length < 2
      || signedDocumentReference.length < 5) throw new Error("Invalid enterprise invoice.");
  await postServerApi("/commercial/enterprise/invoice", {
    agreementId, provider, providerInvoiceId, signedDocumentReference, dueAt,
  });
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
