import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type { BillingGrant, OrganizationMembersOverview, WalletsOverview } from "@authenti8/contracts";
import { hashToken, randomToken } from "../auth/crypto.js";
import { MailService } from "../auth/mail.service.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import type { AdjustWalletDto, InviteMemberDto, ManageBillingGrantDto,
  ManageMemberDto } from "./members.dto.js";

@Injectable()
export class MembersService {
  constructor(@Inject(SupabaseService) private readonly supabase: SupabaseService,
    private readonly mail: MailService) {}

  async overview(userId: string) {
    const result = await this.supabase.rpc<OrganizationMembersOverview | null>(
      "authenti8_members_overview", { userId });
    if (!result) throw new BadRequestException("Organization membership is unavailable.");
    return result;
  }

  async invite(userId: string, input: InviteMemberDto) {
    const token = randomToken();
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
    const result = await this.supabase.rpc<{ created: boolean; email?: string; reason?: string }>(
      "authenti8_invite_organization_member", {
        userId, email: input.email.toLowerCase(), role: input.role,
        tokenHash: hashToken(token), expiresAt,
      });
    if (!result.created || !result.email) {
      throw new BadRequestException(memberMessage(result.reason));
    }
    const previewUrl = await this.mail.dispatchLink(
      result.email, "organization_invitation", token);
    return { created: true, message: "Invitation sent.", previewUrl };
  }

  async accept(userId: string, token: string) {
    const result = await this.supabase.rpc<{ accepted: boolean; reason?: string }>(
      "authenti8_accept_organization_invitation", { userId, tokenHash: hashToken(token) });
    if (!result.accepted) throw new BadRequestException(memberMessage(result.reason));
    return { accepted: true, next: "/dashboard" };
  }

  async manage(userId: string, input: ManageMemberDto) {
    const result = await this.supabase.rpc<{ updated: boolean; reason?: string }>(
      "authenti8_manage_organization_member", { ...input, userId });
    if (!result.updated) throw new BadRequestException(memberMessage(result.reason));
    return result;
  }

  async billingGrants(userId: string) {
    const result = await this.supabase.rpc<BillingGrant[] | null>("authenti8_billing_grants", { userId });
    if (!result) throw new BadRequestException("Owner billing access is required.");
    return result;
  }

  async manageBillingGrant(userId: string, input: ManageBillingGrantDto) {
    const result = await this.supabase.rpc<{ updated: boolean; reason?: string }>(
      "authenti8_manage_billing_grant", { ...input, userId });
    if (!result.updated) throw new BadRequestException(memberMessage(result.reason));
    return result;
  }

  async wallets(userId: string) {
    const result = await this.supabase.rpc<WalletsOverview | null>(
      "authenti8_wallets_overview", { userId });
    if (!result) throw new BadRequestException("Wallet access is unavailable.");
    return result;
  }

  async adjustWallet(userId: string, input: AdjustWalletDto) {
    const result = await this.supabase.rpc<{ updated: boolean; reason?: string }>(
      "authenti8_adjust_hr_wallet", { ...input, userId });
    if (!result.updated) throw new BadRequestException(memberMessage(result.reason));
    return result;
  }
}

function memberMessage(reason?: string) {
  if (reason === "ALREADY_MEMBER") return "That person is already a member.";
  if (reason === "ACCOUNT_ALREADY_ASSIGNED") return "That account already belongs to a workspace.";
  if (reason === "NOT_AUTHORIZED") return "Your role cannot perform this action.";
  if (reason === "OWNER_REQUIRED") return "The organization must retain an active owner.";
  if (reason === "INSUFFICIENT_ORGANIZATION_CREDITS") return "The organization has insufficient unallocated credits.";
  if (reason === "INSUFFICIENT_WALLET") return "The HR wallet has insufficient available credits.";
  if (reason === "GRANT_NOT_FOUND") return "The billing grant is no longer active.";
  return "The invitation or membership update is unavailable.";
}
