import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import type { OnboardingResponse } from "@authenti8/contracts";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service.js";
import { isValidTimezone, normalizeDomain } from "./domain.js";
import type { CreateOrganizationDto } from "./organizations.dto.js";

@Injectable()
export class OrganizationsService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async create(userId: string, input: CreateOrganizationDto): Promise<OnboardingResponse> {
    const domain = normalizeDomain(input.domain);
    if (!domain) throw new BadRequestException("Enter a valid organization domain.");
    if (!isValidTimezone(input.timezone)) throw new BadRequestException("Select a valid timezone.");
    const organizationId = randomUUID();
    try {
      const organization = await this.db.transaction((client) =>
        this.createInsideTransaction(client, organizationId, userId, input, domain),
        { userId, onboardingOrganizationId: organizationId },
      );
      return { organization, next: "/dashboard/subscription" };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException("That organization already has an Authenti8 workspace.");
      }
      throw error;
    }
  }

  private async createInsideTransaction(
    client: PoolClient,
    organizationId: string,
    userId: string,
    input: CreateOrganizationDto,
    domain: string,
  ) {
    await this.assertEligibleUser(client, userId);
    const created = await client.query<{ id: string; name: string; domain: string }>(
      `INSERT INTO organizations(
         id, name, domain, company_size, expected_monthly_interviews, default_timezone
       ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, domain`,
      [organizationId, input.name.trim(), domain, input.companySize,
        input.expectedMonthlyInterviews, input.timezone],
    );
    const organization = created.rows[0]!;
    await this.createDefaults(client, organization.id, userId, input.jobRole);
    return { ...organization, role: "OWNER" as const };
  }

  private async assertEligibleUser(client: PoolClient, userId: string) {
    const user = await client.query<{ verified: boolean }>(
      `SELECT (email_verified_at IS NOT NULL) verified FROM users
       WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE`,
      [userId],
    );
    if (!user.rows[0]?.verified) throw new BadRequestException("Verify your email first.");
    const membership = await client.query(
      "SELECT 1 FROM organization_members WHERE user_id = $1 LIMIT 1",
      [userId],
    );
    if (membership.rowCount) throw new ConflictException("Your workspace is already configured.");
  }

  private async createDefaults(
    client: PoolClient,
    organizationId: string,
    userId: string,
    jobRole: string,
  ) {
    await client.query(
      "INSERT INTO organization_members(organization_id, user_id, role, job_role) VALUES ($1, $2, 'OWNER', $3)",
      [organizationId, userId, jobRole],
    );
    await client.query(
      "INSERT INTO interview_policies(organization_id, name, mode, is_default) VALUES ($1, 'Strict evidence policy', 'STRICT', true)",
      [organizationId],
    );
    await client.query(
      "INSERT INTO subscriptions(organization_id, plan_key, status) VALUES ($1, 'PILOT', 'TRIALING')",
      [organizationId],
    );
    await client.query(
      `INSERT INTO credit_transactions(organization_id, amount, kind, idempotency_key)
       VALUES ($1, 0, 'OPENING_BALANCE', $2)`,
      [organizationId, `opening:${organizationId}`],
    );
    await client.query(
      `INSERT INTO audit_logs(organization_id, actor_user_id, action, target_type, target_id)
       VALUES ($1, $2, 'ORGANIZATION_CREATED', 'organization', $3)`,
      [organizationId, userId, organizationId],
    );
  }
}

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}
