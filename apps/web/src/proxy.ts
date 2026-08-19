import { NextResponse, type NextRequest } from "next/server";

const testOrigin = process.env.NODE_ENV !== "production"
  ? process.env.AUTHENTI8_E2E_ORIGIN
  : undefined;
const landingOrigin = testOrigin ?? process.env.APP_ORIGIN ?? "http://localhost:3000";
const authOrigin = testOrigin ?? process.env.AUTH_ORIGIN ?? landingOrigin;
const onboardingOrigin = testOrigin ?? process.env.ONBOARDING_ORIGIN ?? landingOrigin;
const dashboardOrigin = testOrigin ?? process.env.DASHBOARD_ORIGIN ?? landingOrigin;
const paymentOrigin = testOrigin ?? process.env.PAYMENT_ORIGIN ?? dashboardOrigin;

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const canonicalOrigin = originForPath(pathname);
  if (!testOrigin && canonicalOrigin && new URL(canonicalOrigin).host !== request.nextUrl.host) {
    return NextResponse.redirect(new URL(`${pathname}${search}`, canonicalOrigin));
  }

  const rootDestination = rootPathForHost(request.nextUrl.host);
  if (!testOrigin && pathname === "/" && rootDestination) {
    return NextResponse.redirect(new URL(rootDestination, request.url));
  }

  const protectedRoute = pathname.startsWith("/dashboard")
    || pathname.startsWith("/onboarding");
  if (protectedRoute && !request.cookies.has("authenti8_session")) {
    const login = new URL("/login", authOrigin);
    login.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

function originForPath(pathname: string) {
  if (isAuthPath(pathname)) return authOrigin;
  if (pathname === "/onboarding" || pathname.startsWith("/onboarding/")) {
    return onboardingOrigin;
  }
  if (pathname === "/dashboard/subscription"
    || pathname.startsWith("/dashboard/subscription/")) return paymentOrigin;
  if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) {
    return dashboardOrigin;
  }
  return undefined;
}

function isAuthPath(pathname: string) {
  return [
    "/login", "/signup", "/forgot-password", "/reset-password",
    "/verify-email", "/auth/complete",
  ].some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

function rootPathForHost(host: string) {
  const landingHost = new URL(landingOrigin).host;
  if (host !== landingHost && host === new URL(authOrigin).host) return "/login";
  if (host !== landingHost && host === new URL(onboardingOrigin).host) return "/onboarding";
  if (host !== landingHost && host === new URL(paymentOrigin).host) {
    return "/dashboard/subscription";
  }
  if (host !== landingHost && host === new URL(dashboardOrigin).host) return "/dashboard";
  return undefined;
}

export const config = {
  matcher: ["/((?!api/|_next/|favicon.ico|robots.txt|sitemap.xml).*)"],
};
