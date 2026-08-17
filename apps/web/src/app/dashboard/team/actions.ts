"use server";

import { revalidatePath } from "next/cache";
import { postServerApi, requireSession } from "@/lib/server-api";

export async function inviteMember(formData: FormData) {
  await requireSession();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "");
  if (!email || !["MANAGER", "HR"].includes(role)) throw new Error("Invalid invitation.");
  await postServerApi("/organization/members/invite", { email, role });
  revalidatePath("/dashboard/team");
}

export async function manageMember(formData: FormData) {
  await requireSession();
  const memberId = String(formData.get("memberId") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(memberId) || !["ACTIVE", "SUSPENDED", "REMOVED"].includes(status)) {
    throw new Error("Invalid member update.");
  }
  await postServerApi("/organization/members/manage", { memberId, status });
  revalidatePath("/dashboard/team");
}
