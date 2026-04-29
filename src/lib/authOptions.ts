import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { loadAccessControlPolicy } from "@/lib/accessControlStore";

function parseCsvLowerSet(raw: string | undefined) {
  return new Set(
    String(raw || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function extractEmailDomain(email: string) {
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return "";
  return email.slice(at + 1).toLowerCase();
}

const allowedDomains = parseCsvLowerSet(process.env.AUTH_ALLOWED_DOMAINS);

const googleClientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
const googleClientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
const authSecret = String(process.env.AUTH_SECRET || "").trim();

if (!googleClientId || !googleClientSecret || !authSecret) {
  throw new Error(
    "Missing SSO env vars. Required: AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET",
  );
}

export const authOptions: NextAuthOptions = {
  secret: authSecret,
  providers: [
    GoogleProvider({
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      authorization: {
        params: {
          prompt: "select_account",
        },
      },
    }),
  ],
  pages: {
    signIn: "/login",
    error: "/login",
  },
  session: {
    strategy: "jwt",
  },
  callbacks: {
    async signIn({ account, user, profile }) {
      if (account?.provider !== "google") return false;

      const email = String(user.email || "").trim().toLowerCase();
      const hostedDomain = String((profile as { hd?: unknown } | undefined)?.hd || "")
        .trim()
        .toLowerCase();
      const emailVerified =
        (profile as { email_verified?: unknown } | undefined)?.email_verified === true;

      if (!email || !emailVerified) return false;
      const { policy } = await loadAccessControlPolicy();
      if (policy.allowedEmails.includes(email)) return true;
      const emailDomain = extractEmailDomain(email);
      if (allowedDomains.size && allowedDomains.has(emailDomain)) return true;
      if (allowedDomains.size && hostedDomain && allowedDomains.has(hostedDomain)) return true;
      return false;
    },
    async jwt({ token }) {
      const email = String(token.email || "").trim().toLowerCase();
      const { policy } = await loadAccessControlPolicy();
      token.role = policy.adminEmails.includes(email) ? "admin" : "viewer";
      return token;
    },
    async session({ session, token }) {
      const role = String(token.role || "viewer") === "admin" ? "admin" : "viewer";
      (session.user as { role?: string } | undefined) = {
        ...(session.user || {}),
        role,
      };
      return session;
    },
  },
};
