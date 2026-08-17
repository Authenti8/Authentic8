"use client";

import type { OrganizationMember } from "@authenti8/contracts";
import { useState } from "react";
import { manageBillingGrant } from "./actions";

export function BillingDelegationForm({ managers }: { managers: OrganizationMember[] }) {
  const [expiresAt, setExpiresAt] = useState("");
  return <form className="grant-form" action={manageBillingGrant}>
    <select name="managerUserId" required><option value="">Select manager</option>
      {managers.map((member) => <option key={member.userId}
        value={member.userId}>{member.name}</option>)}</select>
    <input aria-label="Optional grant expiry" onChange={(event) => setExpiresAt(
      event.currentTarget.value ? new Date(event.currentTarget.value).toISOString() : "")}
      type="datetime-local" />
    <input name="expiresAt" type="hidden" value={expiresAt} />
    <input type="number" min={1} name="perPurchaseLimitMinor"
      placeholder="Per-purchase minor units" />
    <input type="number" min={1} name="monthlyLimitMinor" placeholder="Monthly minor units" />
    <input minLength={10} maxLength={500} name="reason" required
      placeholder="Reason for grant" /><button>Grant or update</button>
  </form>;
}
