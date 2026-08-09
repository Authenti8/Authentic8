import { IsIn, IsInt, IsOptional, Max, Min } from "class-validator";

export class CreateCheckoutDto {
  @IsIn(["PROFESSIONAL", "EXTRA_CREDITS"])
  purpose!: "PROFESSIONAL" | "EXTRA_CREDITS";

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  quantity?: number;
}

