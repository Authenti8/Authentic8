"use client";

import type { OrganizationMember } from "@authenti8/contracts";
import { useState } from "react";
import { manageBillingGrant } from "./actions";

export function BillingDelegationForm({ managers }: { managers: OrganizationMember[] }) {
  const [expiresAt, setExpiresAt] = useState("");
  return <form className="grant-form" action={manageBillingGrant}>
    <label>Manager<select name="managerUserId" required><option value="">Select manager</option>
      {managers.map((member) => <option key={member.userId}
        value={member.userId}>{member.name}</option>)}</select></label>
    <label>Access expires <span>Optional</span><input onChange={(event) => setExpiresAt(
      event.currentTarget.value ? new Date(event.currentTarget.value).toISOString() : "")}
      type="datetime-local" /></label>
    <input name="expiresAt" type="hidden" value={expiresAt} />
    <label>Per-purchase limit <span>Minor units</span><input type="number" min={1}
      name="perPurchaseLimitMinor" placeholder="Optional" /></label>
    <label>Monthly limit <span>Minor units</span><input type="number" min={1}
      name="monthlyLimitMinor" placeholder="Optional" /></label>
    <label className="grant-reason">Reason<input minLength={10} maxLength={500} name="reason"
      required placeholder="Why does this manager need purchase access?" /></label>
    <button>Grant or update access</button>
  </form>;
}
