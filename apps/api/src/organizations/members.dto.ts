import { Transform } from "class-transformer";
import { IsEmail, IsIn, IsString, IsUUID, Matches, MaxLength } from "class-validator";

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
