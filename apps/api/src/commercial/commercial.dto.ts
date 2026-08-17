import { Transform } from "class-transformer";
import { Type } from "class-transformer";
import { IsBoolean, IsEmail, IsIn, IsInt, IsISO8601, IsObject, IsOptional, IsString,
  IsUUID, Length, Matches, Max, MaxLength, Min } from "class-validator";

const trim = ({ value }: { value: unknown }) => typeof value === "string" ? value.trim() : value;
const optionalTrim = ({ value }: { value: unknown }) => {
  const output = trim({ value }); return output === "" ? undefined : output;
};

export class SubmitLeadDto {
  @IsIn(["WAITLIST"])
  leadType!: "WAITLIST";

  @Transform(trim)
  @IsString()
  @Length(2, 100)
  fullName!: string;

  @Transform(trim)
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @Transform(trim)
  @IsString()
  @Length(2, 160)
  companyName!: string;

  @IsOptional() @IsString() @MaxLength(300) sourcePath?: string;
  @IsOptional() @IsString() @MaxLength(500) referrer?: string;
  @IsOptional() @IsObject() attribution?: Record<string, string>;
}

export class ManageStaffDto {
  @Transform(trim) @IsEmail() @MaxLength(320) email!: string;
  @IsIn(["PLATFORM_FOUNDER", "PLATFORM_SALES"])
  role!: "PLATFORM_FOUNDER" | "PLATFORM_SALES";
  @IsIn(["ACTIVE", "SUSPENDED", "REMOVED"])
  status!: "ACTIVE" | "SUSPENDED" | "REMOVED";
  @Transform(trim) @IsString() @Length(10, 500) reason!: string;
}

export class UpdateLeadDto {
  @IsUUID() leadId!: string;
  @IsOptional() @IsIn(["NEW", "CONTACTED", "QUALIFIED", "DEMO_SCHEDULED",
    "PROPOSAL_SENT", "WON", "LOST"]) stage?: string;
  @IsOptional() @IsUUID() assignedTo?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) note?: string;
  @IsOptional() @IsISO8601() followUpDueAt?: string;
  @IsOptional() @IsBoolean() completeFollowUp?: boolean;
}

export class ConvertLeadDto {
  @IsUUID() leadId!: string;
  @IsUUID() organizationId!: string;
}

export class CommercialOverviewQueryDto {
  @IsOptional() @Transform(optionalTrim) @IsIn(["DEMO_REQUEST", "WAITLIST"]) leadType?: string;
  @IsOptional() @Transform(optionalTrim) @IsIn(["NEW", "CONTACTED", "QUALIFIED", "DEMO_SCHEDULED",
    "PROPOSAL_SENT", "WON", "LOST"]) stage?: string;
  @IsOptional() @Transform(optionalTrim) @IsUUID() owner?: string;
  @IsOptional() @Transform(optionalTrim) @IsString() @MaxLength(160) company?: string;
  @IsOptional() @Transform(optionalTrim) @IsIn(["DUE", "UPCOMING", "COMPLETED"])
  followUpStatus?: string;
  @IsOptional() @Transform(optionalTrim) @IsString() @MaxLength(400) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 25;
}

export class CommercialOrganizationQueryDto {
  @Transform(trim) @IsString() @Length(2, 160) query!: string;
}

export class EnterpriseProposalDto {
  @IsUUID() leadId!: string;
  @IsUUID() organizationId!: string;
  @Type(() => Number) @IsInt() @Min(1) contractValueMinor!: number;
  @Transform(trim) @IsString() @Matches(/^[A-Z]{3}$/) currency!: string;
  @IsIn(["MONTHLY", "ANNUAL", "ONE_TIME"]) billingInterval!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(1000000) purchasedCredits!: number;
  @IsISO8601() effectiveAt!: string;
  @IsOptional() @IsISO8601() expiresAt?: string;
  @Type(() => Number) @IsInt() @Min(0) @Max(365) paymentTermsDays!: number;
  @IsOptional() @Transform(optionalTrim) @IsString() @MaxLength(500)
  signedDocumentReference?: string;
}

export class EnterpriseInvoiceDto {
  @IsUUID() agreementId!: string;
  @Transform(trim) @IsString() @Length(2, 30) provider!: string;
  @Transform(trim) @IsString() @Length(2, 200) providerInvoiceId!: string;
  @IsISO8601() dueAt!: string;
  @Transform(trim) @IsString() @Length(5, 500) signedDocumentReference!: string;
}

export class EnterprisePaymentDto {
  @Transform(trim) @IsString() @Length(2, 30) provider!: string;
  @Transform(trim) @IsString() @Length(2, 200) providerInvoiceId!: string;
  @Transform(trim) @IsString() @Length(2, 200) providerPaymentId!: string;
  @Transform(trim) @IsString() @Length(2, 200) providerEventId!: string;
  @Type(() => Number) @IsInt() @Min(1) amountMinor!: number;
  @Transform(trim) @Matches(/^[A-Z]{3}$/) currency!: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(1000000) credits!: number;
}
