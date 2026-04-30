"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

function shouldHide(pathname: string) {
  return pathname === "/login" || pathname === "/privacy-policy" || pathname === "/eula";
}

export default function HardRefreshButton() {
  const pathname = usePathname();
  const [loading, setLoading] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    const loadSession = async () => {
      try {
        const res = await fetch("/api/auth/session", { cache: "no-store" });
        if (!res.ok) return;
        const payload = (await res.json()) as { user?: { role?: string } };
        if (!active) return;
        setIsAdmin(String(payload?.user?.role || "").trim().toLowerCase() === "admin");
      } catch {
        if (!active) return;
        setIsAdmin(false);
      }
    };
    void loadSession();
    return () => {
      active = false;
    };
  }, []);

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

  async function syncNow() {
    setSyncLoading(true);
    setMessage("");
    try {
      const res = await fetch("/api/cache/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ warmup: true }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      setMessage("Sync completed.");
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "Sync failed");
    } finally {
      setSyncLoading(false);
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
      <div style={{ display: "flex", gap: 8 }}>
        {isAdmin ? (
          <button
            type="button"
            onClick={() => void syncNow()}
            disabled={syncLoading || loading}
            style={{
              borderRadius: 10,
              border: "1px solid #1d4ed8",
              background: syncLoading ? "#1e3a8a" : "#2563eb",
              color: "#ffffff",
              padding: "10px 12px",
              fontSize: 13,
              fontWeight: 700,
              cursor: syncLoading || loading ? "wait" : "pointer",
            }}
            title="Recalculate and persist cache in private blob"
          >
            {syncLoading ? "Syncing..." : "Sync now"}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void hardRefresh()}
          disabled={loading || syncLoading}
          style={{
            borderRadius: 10,
            border: "1px solid #0f172a",
            background: loading ? "#1f2937" : "#111827",
            color: "#ffffff",
            padding: "10px 12px",
            fontSize: 13,
            fontWeight: 700,
            cursor: loading || syncLoading ? "wait" : "pointer",
          }}
          title="Clear server caches and reload all data from scratch"
        >
          {loading ? "Refreshing..." : "Hard refresh"}
        </button>
      </div>
    </div>
  );
}
