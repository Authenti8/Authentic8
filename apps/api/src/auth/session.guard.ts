import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { AuthService } from "./auth.service.js";
import type { AuthenticatedRequest } from "./auth.types.js";
import { readCookie, SESSION_COOKIE } from "./cookies.js";

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    const rawToken = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (!rawToken) throw new UnauthorizedException("Authentication required.");
    const session = await this.auth.resolveSession(rawToken);
    if (!session) throw new UnauthorizedException("Session expired.");
    (request as unknown as AuthenticatedRequest).session = session;
    return true;
  }
}
