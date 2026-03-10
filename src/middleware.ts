import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const url = new URL("/", request.url);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/diff-sheet/:path*", "/stripe/:path*"],
};
