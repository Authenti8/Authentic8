import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import type { OnboardingResponse } from "@authenti8/contracts";
import { SupabaseService } from "../supabase/supabase.service.js";
import { isValidTimezone, normalizeDomain } from "./domain.js";
import type { CreateOrganizationDto } from "./organizations.dto.js";

type OrganizationResult = OnboardingResponse["organization"] | null;

@Injectable()
export class OrganizationsService {
  constructor(@Inject(SupabaseService) private readonly supabase: SupabaseService) {}

  async create(userId: string, input: CreateOrganizationDto): Promise<OnboardingResponse> {
    const domain = normalizeDomain(input.domain);
    if (!domain) throw new BadRequestException("Enter a valid organization domain.");
    if (!isValidTimezone(input.timezone)) throw new BadRequestException("Select a valid timezone.");
    const result = await this.supabase.rpc<{ organization: OrganizationResult; reason?: string }>(
      "authenti8_create_organization",
      {
        userId, name: input.name.trim(), domain, jobRole: input.jobRole,
        companySize: input.companySize,
        expectedMonthlyInterviews: input.expectedMonthlyInterviews,
        timezone: input.timezone,
      },
    );
    if (result.reason === "INELIGIBLE") throw new BadRequestException("Verify your email first.");
    if (!result.organization) {
      throw new ConflictException("That organization or user already has an Authenti8 workspace.");
    }
    return { organization: result.organization, next: "/dashboard/subscription" };
  }
}
