import { Transform } from "class-transformer";
import { Type } from "class-transformer";
import { IsBoolean, IsEmail, IsIn, IsInt, IsISO8601, IsObject, IsOptional, IsString,
  IsUUID, Length, Max, MaxLength, Min } from "class-validator";

const trim = ({ value }: { value: unknown }) => typeof value === "string" ? value.trim() : value;
const optionalTrim = ({ value }: { value: unknown }) => {
  const output = trim({ value }); return output === "" ? undefined : output;
};

export class SubmitLeadDto {
  @IsIn(["DEMO_REQUEST", "WAITLIST"])
  leadType!: "DEMO_REQUEST" | "WAITLIST";

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
