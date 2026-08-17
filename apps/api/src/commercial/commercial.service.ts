import { BadRequestException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { CommercialOverview, EnterpriseAgreement } from "@authenti8/contracts";
import { SupabaseService } from "../supabase/supabase.service.js";
import { loadConfig } from "../config.js";
import type { ConvertLeadDto, EnterpriseInvoiceDto, EnterpriseProposalDto, ManageStaffDto,
  SubmitLeadDto, UpdateLeadDto } from "./commercial.dto.js";

@Injectable()
export class CommercialService {
  private readonly config = loadConfig();
  constructor(@Inject(SupabaseService) private readonly supabase: SupabaseService) {}

  async submit(input: SubmitLeadDto) {
    const result = await this.supabase.rpc<{ accepted: boolean }>(
      "authenti8_submit_commercial_lead", { ...input,
        salesNotificationEmail: this.config.salesNotificationEmail || undefined });
    if (!result.accepted) throw new BadRequestException("Enter valid contact information.");
    return { accepted: true, message: "Thank you. You have been added to the Authenti8 waitlist." };
  }

  async overview(userId: string, input: Record<string, unknown> = {}) {
    if (this.config.platformFounderEmail) {
      await this.supabase.rpc("authenti8_bootstrap_platform_founder", {
        userId, founderEmail: this.config.platformFounderEmail });
    }
    const result = await this.supabase.rpc<CommercialOverview | null>(
      "authenti8_commercial_overview", { ...input, userId });
    if (!result) throw new ForbiddenException("Commercial operations access is required.");
    const limit = typeof input.limit === "number" ? input.limit : 25;
    const hasMore = result.leads.length > limit;
    const leads = result.leads.slice(0, limit);
    const last = leads.at(-1);
    const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({
      updatedAt: last.updatedAt, id: last.id })).toString("base64url") : null;
    return { ...result, leads, nextCursor };
  }

  async organizations(userId: string, query: string) {
    const result = await this.supabase.rpc<Array<{ id: string; name: string; domain: string }> | null>(
      "authenti8_commercial_organizations", { userId, query });
    if (!result) throw new ForbiddenException("Founder access is required.");
    return result;
  }

  async manageStaff(userId: string, input: ManageStaffDto) {
    const result = await this.supabase.rpc<{ updated: boolean; reason?: string }>(
      "authenti8_manage_platform_staff", { ...input, userId });
    if (!result.updated) throw new BadRequestException(result.reason ?? "Staff update failed.");
    return result;
  }

  async updateLead(userId: string, input: UpdateLeadDto) {
    const result = await this.supabase.rpc<{ updated: boolean; reason?: string }>(
      "authenti8_update_commercial_lead", { ...input, userId });
    if (!result.updated) throw new BadRequestException(result.reason ?? "Lead update failed.");
    return result;
  }

  async convertLead(userId: string, input: ConvertLeadDto) {
    const result = await this.supabase.rpc<{ converted: boolean; reason?: string }>(
      "authenti8_convert_commercial_lead", { ...input, userId });
    if (!result.converted) throw new BadRequestException(result.reason ?? "Lead conversion failed.");
    return result;
  }

  async enterprise(userId: string) {
    const result = await this.supabase.rpc<EnterpriseAgreement[] | null>(
      "authenti8_enterprise_overview", { userId });
    if (!result) throw new ForbiddenException("Commercial agreement access is required.");
    return result;
  }

  async proposal(userId: string, input: EnterpriseProposalDto) {
    const result = await this.supabase.rpc<{ updated: boolean; reason?: string }>(
      "authenti8_upsert_enterprise_proposal", { ...input, userId });
    if (!result.updated) throw new BadRequestException(result.reason ?? "Proposal update failed.");
    return result;
  }

  async invoice(userId: string, input: EnterpriseInvoiceDto) {
    const result = await this.supabase.rpc<{ created: boolean; reason?: string }>(
      "authenti8_issue_enterprise_invoice", { ...input, userId });
    if (!result.created) throw new BadRequestException(result.reason ?? "Invoice creation failed.");
    return result;
  }

  async releaseReadiness(userId: string) {
    const result = await this.supabase.rpc<Record<string, unknown> | null>(
      "authenti8_commercial_release_readiness", { userId });
    if (!result) throw new ForbiddenException("Commercial release access is required.");
    return result;
  }
}
