import { NextResponse, type NextRequest } from "next/server";

const protectedPrefixes = ["/dashboard", "/onboarding"];

export function proxy(request: NextRequest) {
  const protectedRoute = protectedPrefixes.some((path) =>
    request.nextUrl.pathname.startsWith(path),
  );
  const hasSession = request.cookies.has("authenti8_session");
  if (protectedRoute && !hasSession) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/onboarding/:path*"],
};
