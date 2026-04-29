type LoginSearchParams = Promise<{
  callbackUrl?: string;
  error?: string;
}>;

function safeCallbackUrl(raw: string | undefined) {
  const value = String(raw || "").trim();
  if (!value.startsWith("/")) return "/combined-all-subs";
  if (value.startsWith("//")) return "/combined-all-subs";
  return value;
}

function loginErrorMessage(error: string) {
  const key = String(error || "").trim();
  if (key === "AccessDenied") {
    return "Access denied. Use an approved company Google account.";
  }
  if (key) return `Login failed: ${key}`;
  return "";
}

export default async function LoginPage(props: { searchParams: LoginSearchParams }) {
  const searchParams = await props.searchParams;
  const callbackUrl = safeCallbackUrl(searchParams.callbackUrl);
  const errorText = loginErrorMessage(String(searchParams.error || ""));
  const signInHref = `/api/auth/signin/google?callbackUrl=${encodeURIComponent(callbackUrl)}`;

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: "24px",
        fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
      }}
    >
      <section
        style={{
          width: "100%",
          maxWidth: 420,
          border: "1px solid #e5e7eb",
          borderRadius: 12,
          padding: 24,
          background: "#ffffff",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 22 }}>Sign in</h1>
        <p style={{ marginTop: 10, marginBottom: 18, color: "#374151" }}>
          Continue with your company Google account.
        </p>

        {errorText ? (
          <p
            style={{
              marginTop: 0,
              marginBottom: 14,
              color: "#b91c1c",
              background: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: 8,
              padding: "10px 12px",
            }}
          >
            {errorText}
          </p>
        ) : null}

        <a
          href={signInHref}
          style={{
            display: "inline-block",
            width: "100%",
            boxSizing: "border-box",
            textAlign: "center",
            textDecoration: "none",
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
        </a>
      </section>
    </main>
  );
}

