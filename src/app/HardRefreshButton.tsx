"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";

function shouldHide(pathname: string) {
  return pathname === "/login" || pathname === "/privacy-policy" || pathname === "/eula";
}

export default function HardRefreshButton() {
  const pathname = usePathname();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  if (shouldHide(pathname)) return null;

  async function hardRefresh() {
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch("/api/cache/hard-refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }

      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set("_hard_refresh", String(Date.now()));
      window.location.replace(nextUrl.toString());
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "Hard refresh failed");
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        right: 12,
        bottom: 12,
        zIndex: 60,
        display: "grid",
        gap: 6,
        justifyItems: "end",
      }}
    >
      {message ? (
        <div
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#b91c1c",
            borderRadius: 8,
            padding: "8px 10px",
            maxWidth: 360,
            fontSize: 12,
          }}
        >
          {message}
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => void hardRefresh()}
        disabled={loading}
        style={{
          borderRadius: 10,
          border: "1px solid #0f172a",
          background: loading ? "#1f2937" : "#111827",
          color: "#ffffff",
          padding: "10px 12px",
          fontSize: 13,
          fontWeight: 700,
          cursor: loading ? "wait" : "pointer",
        }}
        title="Clear server caches and reload all data from scratch"
      >
        {loading ? "Refreshing..." : "Hard refresh"}
      </button>
    </div>
  );
}
