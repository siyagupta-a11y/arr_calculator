import NextAuth, { type DefaultSession } from "next-auth";
import Google from "next-auth/providers/google";

type AppRole = "admin" | "viewer";

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
const adminEmails = parseCsvLowerSet(process.env.AUTH_ADMIN_EMAILS);

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
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

      if (!allowedDomains.size) return true;
      const emailDomain = extractEmailDomain(email);
      if (allowedDomains.has(emailDomain)) return true;
      if (hostedDomain && allowedDomains.has(hostedDomain)) return true;
      return false;
    },
    async jwt({ token }) {
      const email = String(token.email || "").trim().toLowerCase();
      token.role = adminEmails.has(email) ? "admin" : "viewer";
      return token;
    },
    async session({ session, token }) {
      const role = String(token.role || "viewer") === "admin" ? "admin" : "viewer";
      session.user = {
        ...session.user,
        role,
      };
      return session;
    },
  },
});

declare module "next-auth" {
  interface Session {
    user: {
      role: AppRole;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role?: AppRole;
  }
}
