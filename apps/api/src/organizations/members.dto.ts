import { Transform } from "class-transformer";
import { Type } from "class-transformer";
import { IsBoolean, IsEmail, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID,
  Matches, Max, MaxLength, Min } from "class-validator";

const trim = ({ value }: { value: unknown }) => typeof value === "string" ? value.trim() : value;

export class InviteMemberDto {
  @Transform(trim) @IsEmail() @MaxLength(320) email!: string;
  @IsIn(["MANAGER", "HR"]) role!: "MANAGER" | "HR";
}

export class AcceptInvitationDto {
  @IsString() @Matches(/^[A-Za-z0-9_-]{32,256}$/) token!: string;
}

export class ManageMemberDto {
  @IsUUID() memberId!: string;
  @IsIn(["ACTIVE", "SUSPENDED", "REMOVED"])
  status!: "ACTIVE" | "SUSPENDED" | "REMOVED";
}

export class ManageBillingGrantDto {
  @IsUUID() managerUserId!: string;
  @IsOptional() @IsISO8601() expiresAt?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) perPurchaseLimitMinor?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) monthlyLimitMinor?: number;
  @IsOptional() @IsBoolean() revoke?: boolean;
  @Transform(trim) @IsString() @MaxLength(500) @Matches(/^.{10,}$/s) reason!: string;
}

export class AdjustWalletDto {
  @IsUUID() memberUserId!: string;
  @IsIn(["GRANT", "REDUCE"]) operation!: "GRANT" | "REDUCE";
  @Type(() => Number) @IsInt() @Min(1) @Max(100000) quantity!: number;
  @Transform(trim) @IsString() @MaxLength(500) @Matches(/^.{10,}$/s) reason!: string;
  @IsUUID() idempotencyKey!: string;
}
