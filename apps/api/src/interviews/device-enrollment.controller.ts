import { BadRequestException, Body, Controller, GoneException, Inject, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { RateLimiterService } from "../auth/rate-limiter.service.js";
import { DeviceEnrollmentService } from "./device-enrollment.service.js";
import type { DeviceEnrollmentInput } from "./enrollment.types.js";

@Controller("agent/enrollment")
export class DeviceEnrollmentController {
  constructor(
    @Inject(DeviceEnrollmentService) private readonly enrollment: DeviceEnrollmentService,
    @Inject(RateLimiterService) private readonly rateLimiter: RateLimiterService,
  ) {}

  @Post("challenge")
  async challenge(@Body() body: { token?: string }, @Req() request: Request) {
    const token = requireToken(body?.token);
    await this.limit(request, token);
    const result = await this.enrollment.challenge(token);
    if (!result.valid) throw new GoneException("Enrollment request is unavailable.");
    return result;
  }

  @Post("complete")
  async complete(@Body() body: Partial<DeviceEnrollmentInput>, @Req() request: Request) {
    const input = validatedInput(body);
    await this.limit(request, input.token);
    const result = await this.enrollment.complete(input) as EnrollmentCompletion;
    if (!result.enrolled && result.reason === "INVALID_SIGNATURE") {
      throw new BadRequestException("Enrollment proof is invalid.");
    }
    if (!result.enrolled) throw new GoneException("Enrollment request is unavailable.");
    return result;
  }

  private async limit(request: Request, token: string) {
    await this.rateLimiter.consume(
      `ip:${request.ip ?? "unknown"}:agent:enrollment`, 200, 15 * 60_000,
    );
    await this.rateLimiter.consume(`agent:enrollment:token:${token}`, 20, 15 * 60_000);
  }
}

function validatedInput(body: Partial<DeviceEnrollmentInput>) {
  const token = requireToken(body?.token);
  const platformVersion = body.platformVersion ?? "";
  const agentVersion = body.agentVersion ?? "";
  if (!body.publicKey || !body.challengeSignature || body.platform !== "WINDOWS"
    || !validLabel(platformVersion, 100) || !validLabel(agentVersion, 50)
    || (body.deviceName !== undefined && !validLabel(body.deviceName, 200))) {
    throw new BadRequestException("Enrollment details are invalid.");
  }
  return { ...body, token, platformVersion, agentVersion } as DeviceEnrollmentInput;
}

function requireToken(token?: string) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    throw new GoneException("Enrollment request is unavailable.");
  }
  return token;
}

function validLabel(value: string, maximum: number) {
  return value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f]/.test(value);
}

type EnrollmentCompletion = { enrolled?: boolean; reason?: string };
