import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { AuthenticatedRequest } from "./auth.types.js";
import { SupabaseService } from "../supabase/supabase.service.js";

@Injectable()
export class ActiveOrganizationGuard implements CanActivate {
  constructor(@Inject(SupabaseService) private readonly supabase: SupabaseService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = request.session?.userId;
    if (!userId) throw new ForbiddenException("Active organization membership is required.");
    const session = await this.supabase.rpc<{ organization: { id: string } | null } | null>(
      "authenti8_current_session", { userId });
    if (!session?.organization) {
      throw new ForbiddenException("Active organization membership is required.");
    }
    return true;
  }
}
