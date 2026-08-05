import { Transform } from "class-transformer";
import {
  IsDefined,
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";
import { normalizeEmailValue, trimString } from "../validation/transforms.js";

const strongPassword = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).+$/;

export class SignupDto {
  @Transform(({ value }) => trimString(value))
  @IsDefined()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  fullName!: string;

  @Transform(({ value }) => normalizeEmailValue(value))
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(128)
  @Matches(strongPassword, {
    message: "password must contain uppercase, lowercase, number, and symbol",
  })
  password!: string;
}

export class LoginDto {
  @Transform(({ value }) => normalizeEmailValue(value))
  @IsEmail()
  email!: string;

  @IsString()
  @MaxLength(128)
  password!: string;
}

export class EmailDto {
  @Transform(({ value }) => normalizeEmailValue(value))
  @IsEmail()
  email!: string;
}

export class TokenDto {
  @IsString()
  @MinLength(20)
  @MaxLength(512)
  token!: string;
}

export class VerifyEmailDto extends TokenDto {
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password!: string;
}

export class ResetPasswordDto extends TokenDto {
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  @Matches(strongPassword, {
    message: "password must contain uppercase, lowercase, number, and symbol",
  })
  password!: string;
}
