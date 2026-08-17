"use server";

import { redirect } from "next/navigation";
import { postServerApi, requireSession } from "@/lib/server-api";

export async function acceptInvitation(formData: FormData) {
  await requireSession();
  const token = String(formData.get("token") ?? "");
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error("Invalid invitation.");
  await postServerApi("/organization/members/accept", { token });
  redirect("/dashboard");
}
