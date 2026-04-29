"use client";

import { signIn } from "next-auth/react";

export default function GoogleSignInButton({ callbackUrl }: { callbackUrl: string }) {
  return (
    <button
      type="button"
      onClick={() => signIn("google", { callbackUrl })}
      style={{
        width: "100%",
        borderRadius: 10,
        border: "1px solid #d1d5db",
        background: "#111827",
        color: "#ffffff",
        padding: "10px 12px",
        fontSize: 14,
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      Sign in with Google
    </button>
  );
}

