"use client";

import Link from "next/link";
import React, { useMemo, useState } from "react";

type AnalyticsBlock = {
  status: "ok" | "not_configured" | "error";
  value: number | null;
  details?: string;
};

type AnalyticsResponse = {
  startDate: string;
  endDate: string;
  mixpanel: AnalyticsBlock;
  googleAnalytics: AnalyticsBlock;
};

type UploadFieldKey =
  | "stripeMrrPerCustomer"
  | "stripeMrrChanges"
  | "stripeSubscriptionMetrics"
  | "salesAssistWorkspaceIds"
  | "salesledArrFromHibob";

type UploadField = {
  key: UploadFieldKey;
  label: string;
  hint: string;
};

const UPLOAD_FIELDS: UploadField[] = [
  {
    key: "stripeMrrPerCustomer",
    label: "Stripe MRR per customer",
    hint: "CSV or XLSX export",
  },
  {
    key: "stripeMrrChanges",
    label: "Stripe MRR changes",
    hint: "CSV or XLSX export",
  },
  {
    key: "stripeSubscriptionMetrics",
    label: "Stripe subscription metrics",
    hint: "CSV or XLSX export",
  },
  {
    key: "salesAssistWorkspaceIds",
    label: "Sales assist workspace IDs",
    hint: "CSV or TXT list",
  },
  {
    key: "salesledArrFromHibob",
    label: "Sales-led ARR from Hibob",
    hint: "CSV or XLSX export",
  },
];

function defaultDateRange() {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end,
  };
}

function formatNumber(value: number) {
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatBytes(value: number) {
  const size = Number(value || 0);
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

export default function ModelUpdatePage() {
  const defaults = useMemo(() => defaultDateRange(), []);
  const [startDate, setStartDate] = useState(defaults.startDate);
  const [endDate, setEndDate] = useState(defaults.endDate);
  const [files, setFiles] = useState<Partial<Record<UploadFieldKey, File>>>({});
  const [error, setError] = useState<string | null>(null);
  const [readyMessage, setReadyMessage] = useState<string | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [analyticsData, setAnalyticsData] = useState<AnalyticsResponse | null>(null);

  const missingFields = UPLOAD_FIELDS.filter((field) => !files[field.key]);

  function onFileChange(field: UploadFieldKey, file: File | null) {
    setFiles((prev) => {
      const next = { ...prev };
      if (file) next[field] = file;
      else delete next[field];
      return next;
    });
    setError(null);
    setReadyMessage(null);
  }

  function validateInputs() {
    if (!startDate || !endDate) {
      setError("Start date and end date are required.");
      setReadyMessage(null);
      return;
    }
    if (endDate < startDate) {
      setError("End date must be greater than or equal to start date.");
      setReadyMessage(null);
      return;
    }
    if (missingFields.length > 0) {
      setError(`Missing file uploads: ${missingFields.map((field) => field.label).join(", ")}`);
      setReadyMessage(null);
      return;
    }

    setError(null);
    setReadyMessage(
      `Inputs ready for model update run. Date range: ${startDate} to ${endDate}. Uploaded files: ${UPLOAD_FIELDS.length}/${UPLOAD_FIELDS.length}.`,
    );
  }

  async function fetchAnalytics() {
    setAnalyticsLoading(true);
    setAnalyticsError(null);
    try {
      const res = await fetch("/api/model-update-analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startDate, endDate }),
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        if (json && typeof json === "object" && "error" in json) {
          throw new Error(String((json as { error?: unknown }).error || "Analytics request failed"));
        }
        throw new Error(text || `HTTP ${res.status}`);
      }
      if (!json || typeof json !== "object") throw new Error("Invalid analytics response");
      setAnalyticsData(json as AnalyticsResponse);
    } catch (e: unknown) {
      setAnalyticsError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setAnalyticsLoading(false);
    }
  }

  return (
    <div className="stripe-ui">
      <section className="stripe-ui__hero ui-reveal">
        <div className="stripe-ui__eyebrow">Model operations</div>
        <div className="stripe-ui__hero-row">
          <div>
            <h1 className="stripe-ui__title">Model Update</h1>
            <p className="stripe-ui__subtitle">
              Upload required source files and date range for model refresh input packaging.
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
            <Link href="/combined-all-subs" className="stripe-ui__hero-link">
              Open Combined All Subs
            </Link>
            <Link href="/combined-billing-overview" className="stripe-ui__hero-link">
              Open Combined Billing Overview
            </Link>
            <Link href="/stripe-through-mrr" className="stripe-ui__hero-link">
              Open Stripe through MRR
            </Link>
          </div>
        </div>
      </section>

      <section className="stripe-ui__panel ui-reveal ui-reveal-1">
        <h2 className="stripe-ui__panel-title">Inputs</h2>
        <p className="stripe-ui__panel-subtitle">
          Provide date range and upload all 5 files. Files are currently validated client-side.
        </p>

        <div className="stripe-ui__control-grid" style={{ gridTemplateColumns: "repeat(3, minmax(180px, 1fr))" }}>
          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="model-update-start-date">
              Start date
            </label>
            <input
              id="model-update-start-date"
              className="stripe-ui__control"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="model-update-end-date">
              End date
            </label>
            <input
              id="model-update-end-date"
              className="stripe-ui__control"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="model-update-validate">
              Validate
            </label>
            <button
              id="model-update-validate"
              className="stripe-ui__btn stripe-ui__btn--primary"
              onClick={validateInputs}
            >
              Validate inputs
            </button>
          </div>
        </div>

        <div className="stripe-ui__table-wrap" style={{ marginTop: "0.9rem" }}>
          <table className="stripe-ui__table" aria-label="Model update file uploads">
            <thead>
              <tr>
                <th>Input</th>
                <th>Upload</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {UPLOAD_FIELDS.map((field) => {
                const file = files[field.key];
                return (
                  <tr key={field.key}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{field.label}</div>
                      <div className="stripe-ui__hint">{field.hint}</div>
                    </td>
                    <td>
                      <input
                        className="stripe-ui__control"
                        type="file"
                        onChange={(e) => onFileChange(field.key, e.target.files?.[0] || null)}
                      />
                    </td>
                    <td>
                      {file ? (
                        <span>
                          {file.name} ({formatBytes(file.size)})
                        </span>
                      ) : (
                        <span style={{ opacity: 0.75 }}>Missing</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {error && (
          <p className="stripe-ui__panel-subtitle" style={{ color: "#fca5a5", marginTop: "0.75rem", marginBottom: 0 }}>
            {error}
          </p>
        )}
        {readyMessage && (
          <p className="stripe-ui__panel-subtitle" style={{ color: "#86efac", marginTop: "0.75rem", marginBottom: 0 }}>
            {readyMessage}
          </p>
        )}
      </section>

      <section className="stripe-ui__panel ui-reveal ui-reveal-2">
        <h2 className="stripe-ui__panel-title">Analytics (Mixpanel + Google Analytics)</h2>
        <p className="stripe-ui__panel-subtitle">
          Yes, this page can pull numbers. Configure backend endpoints for each provider and click fetch.
        </p>
        <div className="stripe-ui__control-grid" style={{ gridTemplateColumns: "repeat(3, minmax(180px, 1fr))" }}>
          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label">Mixpanel endpoint env</label>
            <div className="stripe-ui__hint">`MODEL_UPDATE_MIXPANEL_ENDPOINT`</div>
          </div>
          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label">Google Analytics endpoint env</label>
            <div className="stripe-ui__hint">`MODEL_UPDATE_GA_ENDPOINT`</div>
          </div>
          <div className="stripe-ui__field">
            <label className="stripe-ui__field-label" htmlFor="model-update-fetch-analytics">
              Fetch
            </label>
            <button
              id="model-update-fetch-analytics"
              className="stripe-ui__btn stripe-ui__btn--ghost"
              onClick={() => void fetchAnalytics()}
              disabled={analyticsLoading}
            >
              {analyticsLoading ? "Fetching..." : "Fetch analytics"}
            </button>
          </div>
        </div>

        {analyticsError && (
          <p className="stripe-ui__panel-subtitle" style={{ color: "#fca5a5", marginTop: "0.75rem", marginBottom: 0 }}>
            {analyticsError}
          </p>
        )}

        {analyticsData && (
          <div className="stripe-ui__stats-grid" style={{ marginTop: "0.9rem" }}>
            <div className="stripe-ui__stat">
              <p className="stripe-ui__stat-label">Mixpanel</p>
              <p className="stripe-ui__stat-value">
                {analyticsData.mixpanel.value != null ? formatNumber(analyticsData.mixpanel.value) : "—"}
              </p>
              <p className="stripe-ui__hint">
                {analyticsData.mixpanel.status}
                {analyticsData.mixpanel.details ? `: ${analyticsData.mixpanel.details}` : ""}
              </p>
            </div>
            <div className="stripe-ui__stat">
              <p className="stripe-ui__stat-label">Google Analytics</p>
              <p className="stripe-ui__stat-value">
                {analyticsData.googleAnalytics.value != null ? formatNumber(analyticsData.googleAnalytics.value) : "—"}
              </p>
              <p className="stripe-ui__hint">
                {analyticsData.googleAnalytics.status}
                {analyticsData.googleAnalytics.details ? `: ${analyticsData.googleAnalytics.details}` : ""}
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
