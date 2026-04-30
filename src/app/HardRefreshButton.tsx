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
  const [syncProgress, setSyncProgress] = useState("");
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
    setSyncProgress("");
    try {
      const startRes = await fetch("/api/cache/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ action: "start", warmup: true }),
      });
      if (!startRes.ok) {
        const text = await startRes.text();
        const snippet = text.replace(/\s+/g, " ").slice(0, 220);
        throw new Error(`Sync start failed (${startRes.status}). ${snippet}`);
      }

      const startPayload = (await startRes.json()) as {
        startedAtUtc?: string;
        totalTasks?: number;
        nextTaskIndex?: number;
        done?: boolean;
      };
      const startedAtUtc = String(startPayload?.startedAtUtc || "").trim() || new Date().toISOString();
      const totalTasks = Math.max(0, Number(startPayload?.totalTasks || 0));
      let nextTaskIndex = Math.max(0, Number(startPayload?.nextTaskIndex || 0));
      let done = Boolean(startPayload?.done) || totalTasks === 0;
      let okTaskCount = 0;
      let failedTaskCount = 0;

      while (!done) {
        setSyncProgress(`Running cache warmup task ${nextTaskIndex + 1}/${totalTasks}...`);
        const stepRes = await fetch("/api/cache/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({
            action: "step",
            taskIndex: nextTaskIndex,
            batchSize: 1,
          }),
        });
        if (!stepRes.ok) {
          const text = await stepRes.text();
          const snippet = text.replace(/\s+/g, " ").slice(0, 220);
          const looksLikeHtml = snippet.toLowerCase().includes("<!doctype html");
          const reason = looksLikeHtml
            ? "Server returned HTML error page (usually timeout or runtime crash)."
            : snippet;
          throw new Error(`Sync step failed (${stepRes.status}). ${reason}`);
        }
        const stepPayload = (await stepRes.json()) as {
          nextIndex?: number;
          done?: boolean;
          results?: Array<{ ok?: boolean }>;
        };
        const stepResults = Array.isArray(stepPayload?.results) ? stepPayload.results : [];
        for (const item of stepResults) {
          if (item?.ok) okTaskCount += 1;
          else failedTaskCount += 1;
        }
        nextTaskIndex = Math.max(nextTaskIndex + 1, Number(stepPayload?.nextIndex || nextTaskIndex + 1));
        done = Boolean(stepPayload?.done) || nextTaskIndex >= totalTasks;
        setLastSyncSummary(`${okTaskCount}/${okTaskCount + failedTaskCount} tasks`);
      }

      await fetch("/api/cache/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          action: "complete",
          warmup: true,
          startedAtUtc,
          okTaskCount,
          failedTaskCount,
          totalTaskCount: okTaskCount + failedTaskCount,
        }),
      });

      setLastSyncAtUtc(new Date().toISOString());
      setLastSyncSummary(`${okTaskCount}/${okTaskCount + failedTaskCount} tasks`);
      if (failedTaskCount > 0) {
        setMessage(`Sync completed with ${failedTaskCount} failed task(s).`);
      } else {
        setMessage("Sync completed.");
      }
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "Sync failed");
    } finally {
      setSyncProgress("");
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
      {syncProgress ? (
        <div
          style={{
            background: "#eff6ff",
            border: "1px solid #bfdbfe",
            color: "#1e3a8a",
            borderRadius: 8,
            padding: "8px 10px",
            maxWidth: 360,
            fontSize: 12,
          }}
        >
          {syncProgress}
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
