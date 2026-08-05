import { redirect } from "next/navigation";
import { requireSession } from "@/lib/server-api";

export default async function AuthCompletePage() {
  const session = await requireSession();
  redirect(session.organization ? "/dashboard" : "/onboarding");
}
