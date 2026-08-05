import { Transform, Type } from "class-transformer";
import {
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { trimString } from "../validation/transforms.js";

const sizes = ["1-10", "11-50", "51-200", "201-1000", "1000+"];
const roles = ["Founder", "Hiring manager", "Recruiter", "People leader", "Other"];

export class CreateOrganizationDto {
  @Transform(({ value }) => trimString(value))
  @IsDefined()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @Transform(({ value }) => {
    const trimmed = trimString(value);
    return typeof trimmed === "string" ? trimmed.toLowerCase() : trimmed;
  })
  @IsString()
  @MinLength(3)
  @MaxLength(253)
  domain!: string;

  @IsIn(roles)
  jobRole!: string;

  @IsIn(sizes)
  companySize!: string;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  expectedMonthlyInterviews?: number;

  @Transform(({ value }) => trimString(value))
  @IsOptional()
  @IsString()
  @MaxLength(100)
  timezone?: string;
}
