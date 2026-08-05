import type { Response } from "express";
import { loadConfig } from "../config.js";
import type { SessionToken } from "./auth.types.js";

export const SESSION_COOKIE = "authenti8_session";
export const OAUTH_STATE_COOKIE = "authenti8_oauth_state";

export function setSessionCookie(response: Response, token: SessionToken) {
  response.cookie(SESSION_COOKIE, token.rawToken, {
    httpOnly: true,
    secure: loadConfig().isProduction,
    sameSite: "lax",
    path: "/",
    expires: token.expiresAt,
    priority: "high",
  });
}

export function clearSessionCookie(response: Response) {
  response.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: loadConfig().isProduction,
    sameSite: "lax",
    path: "/",
  });
}

export function setOauthStateCookie(response: Response, state: string) {
  response.cookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: loadConfig().isProduction,
    sameSite: "lax",
    path: "/api/v1/auth/google/callback",
    maxAge: 10 * 60 * 1000,
    priority: "high",
  });
}

export function clearOauthStateCookie(response: Response) {
  response.clearCookie(OAUTH_STATE_COOKIE, {
    httpOnly: true,
    secure: loadConfig().isProduction,
    sameSite: "lax",
    path: "/api/v1/auth/google/callback",
  });
}

export function readCookie(header: string | undefined, name: string) {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return safeDecodeCookie(value.join("="));
  }
  return undefined;
}

function safeDecodeCookie(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
