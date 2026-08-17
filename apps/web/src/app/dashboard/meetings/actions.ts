"use server";

import { revalidatePath } from "next/cache";
import { postServerApi, requireSession } from "@/lib/server-api";

export async function assignInterview(formData: FormData) {
  await requireSession();
  const interviewId = String(formData.get("interviewId") ?? "");
  const memberUserId = String(formData.get("memberUserId") ?? "");
  if (!uuid(interviewId) || !uuid(memberUserId)) throw new Error("Invalid interview assignment.");
  await postServerApi(`/meetings/${interviewId}/assign`, { memberUserId });
  revalidatePath("/dashboard/meetings");
}

function uuid(value: string) { return /^[0-9a-f-]{36}$/i.test(value); }
