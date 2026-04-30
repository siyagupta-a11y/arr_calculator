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
  const [lastSyncAtUtc, setLastSyncAtUtc] = useState("");
  const [lastSyncSummary, setLastSyncSummary] = useState("");
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
    const loadCacheStatus = async () => {
      try {
        const res = await fetch("/api/cache/status", { cache: "no-store" });
        if (!res.ok) return;
        const payload = (await res.json()) as {
          lastSync?: {
            finishedAtUtc?: string;
            okTaskCount?: number;
            failedTaskCount?: number;
            totalTaskCount?: number;
          } | null;
        };
        if (!active) return;
        const finishedAtUtc = String(payload?.lastSync?.finishedAtUtc || "").trim();
        if (finishedAtUtc) {
          setLastSyncAtUtc(finishedAtUtc);
          const ok = Number(payload?.lastSync?.okTaskCount || 0);
          const total = Number(payload?.lastSync?.totalTaskCount || 0);
          if (total > 0) {
            setLastSyncSummary(`${ok}/${total} tasks`);
          }
        }
      } catch {
        if (!active) return;
      }
    };
    void loadCacheStatus();
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
      const payload = (await res.json()) as {
        finishedAtUtc?: string;
        tasks?: Array<{ ok?: boolean }>;
      };
      const finishedAtUtc = String(payload?.finishedAtUtc || "").trim();
      if (finishedAtUtc) setLastSyncAtUtc(finishedAtUtc);
      const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
      if (tasks.length) {
        const ok = tasks.filter((task) => task?.ok).length;
        setLastSyncSummary(`${ok}/${tasks.length} tasks`);
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
      {lastSyncAtUtc ? (
        <div
          style={{
            background: "#ecfdf5",
            border: "1px solid #a7f3d0",
            color: "#065f46",
            borderRadius: 8,
            padding: "6px 10px",
            maxWidth: 420,
            fontSize: 12,
          }}
        >
          Last sync: {new Date(lastSyncAtUtc).toUTCString()}
          {lastSyncSummary ? ` (${lastSyncSummary})` : ""}
        </div>
      ) : null}
    </div>
  );
}
