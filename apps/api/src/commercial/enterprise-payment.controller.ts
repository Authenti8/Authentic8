import { Body, Controller, Headers, Post, UnauthorizedException } from "@nestjs/common";
import { validBearerToken } from "../auth/bearer.js";
import { loadConfig } from "../config.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import { EnterprisePaymentDto } from "./commercial.dto.js";

@Controller("internal/commercial")
export class EnterprisePaymentController {
  private readonly config = loadConfig();
  constructor(private readonly supabase: SupabaseService) {}

  @Post("enterprise-payment")
  apply(@Headers("authorization") authorization: string | undefined,
    @Body() body: EnterprisePaymentDto) {
    if (!validBearerToken(authorization, this.config.cronSecret)) throw new UnauthorizedException();
    return this.supabase.rpc("authenti8_apply_enterprise_payment", { ...body });
  }
}
