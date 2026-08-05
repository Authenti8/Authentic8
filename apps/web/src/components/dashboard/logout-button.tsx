"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/api";

export function LogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function logout() {
    setPending(true);
    setError("");
    try {
      await postJson("/auth/logout", {});
      router.replace("/login");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not log out. Try again.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div>
      <button className="logout-button" disabled={pending} onClick={logout} type="button">
        <LogOut size={16} /> {pending ? "Logging out…" : "Log out"}
      </button>
      {error && <p className="logout-error" role="alert">{error}</p>}
    </div>
  );
}
