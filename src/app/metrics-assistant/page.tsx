"use client";

import Link from "next/link";
import React, { useMemo, useState } from "react";

type AssistantResponse = {
  status: "ok" | "needs_clarification";
  answer: string;
  parsed: {
    metric: "churn" | "ai_spend" | null;
    segment: "total" | "selfserve" | "sales_assist";
    country: string;
    monthKey: string;
    monthLabel: string;
    startDate: string;
    endDate: string;
  };
  warnings: string[];
  table: {
    columns: string[];
    rows: Array<Record<string, string | number>>;
  };
};

function defaultQuestion() {
  return "What is the total churn in Brazil in April 2025?";
}

function displayValue(value: string | number | null | undefined) {
  if (typeof value === "number") {
    return new Intl.NumberFormat(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  }
  return String(value ?? "");
}

export default function MetricsAssistantPage() {
  const initialQuestion = useMemo(() => defaultQuestion(), []);
  const [question, setQuestion] = useState(initialQuestion);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AssistantResponse | null>(null);

  async function runQuery() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/metrics-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!response.ok) {
        if (json && typeof json === "object" && "error" in json) {
          throw new Error(String((json as { error?: unknown }).error || "Request failed"));
        }
        throw new Error(text || `HTTP ${response.status}`);
      }
      if (!json || typeof json !== "object") throw new Error("Invalid response");
      setResult(json as AssistantResponse);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="stripe-ui">
      <section className="stripe-ui__hero ui-reveal">
        <div className="stripe-ui__eyebrow">Revenue intelligence</div>
        <div className="stripe-ui__hero-row">
          <div>
            <h1 className="stripe-ui__title">Metrics Assistant</h1>
            <p className="stripe-ui__subtitle">
              Ask natural-language questions and get a table from the existing ARR metric logic.
            </p>
            <p className="stripe-ui__subtitle" style={{ color: "#b91c1c", fontWeight: 700 }}>
              Under maintenance. Do not use.
            </p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
            <Link href="/combined-all-subs" className="stripe-ui__hero-link">
              Open Combined All Subs
            </Link>
            <Link href="/combined-billing-overview" className="stripe-ui__hero-link">
              Open Combined Billing Overview
            </Link>
            <Link href="/hubspot" className="stripe-ui__hero-link">
              Open HubSpot report
            </Link>
          </div>
        </div>
      </section>

      <section className="stripe-ui__panel ui-reveal ui-reveal-1">
        <h2 className="stripe-ui__panel-title">Ask a question</h2>
        <p className="stripe-ui__panel-subtitle">
          Examples: “total churn in Brazil in April 2025”, “self serve churn in 2025-04”, “AI spend in March 2026”.
        </p>
        <div className="stripe-ui__error" style={{ marginBottom: "1rem" }}>
          <h2>Under maintenance</h2>
          <p>For testing only. Numbers may be incorrect.</p>
        </div>
        <div className="stripe-ui__field">
          <label className="stripe-ui__field-label" htmlFor="metrics-assistant-question">
            Question
          </label>
          <textarea
            id="metrics-assistant-question"
            className="stripe-ui__control"
            rows={4}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="What is the total churn in Brazil in April 2025?"
          />
        </div>
        <div className="stripe-ui__actions">
          <button
            className="stripe-ui__button stripe-ui__button--primary"
            onClick={runQuery}
            disabled={loading}
            type="button"
          >
            {loading ? "Running..." : "Ask"}
          </button>
          <button
            className="stripe-ui__button"
            onClick={() => setQuestion(initialQuestion)}
            disabled={loading}
            type="button"
          >
            Reset Example
          </button>
        </div>
      </section>

      {error ? (
        <section className="stripe-ui__error ui-reveal ui-reveal-2">
          <h2>Error</h2>
          <p>{error}</p>
        </section>
      ) : null}

      {result ? (
        <section className="stripe-ui__panel ui-reveal ui-reveal-2">
          <h2 className="stripe-ui__panel-title">Answer</h2>
          <p className="stripe-ui__panel-subtitle">{result.answer}</p>

          <div className="stripe-ui__meta" style={{ marginTop: "1rem" }}>
            Parsed: metric={String(result.parsed.metric || "")}, segment={result.parsed.segment},
            month={result.parsed.monthKey || "(none)"}, country={result.parsed.country || "(none)"}
          </div>

          {result.warnings.length ? (
            <div className="stripe-ui__panel-subtitle" style={{ marginTop: "0.75rem", color: "#b45309" }}>
              {result.warnings.join(" ")}
            </div>
          ) : null}

          {result.table.columns.length > 0 ? (
            <div className="stripe-ui__table-wrap stripe-ui__table-wrap--compact" style={{ marginTop: "1rem" }}>
              <table className="stripe-ui__table">
                <thead>
                  <tr>
                    {result.table.columns.map((column) => (
                      <th key={column}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.table.rows.map((row, rowIndex) => (
                    <tr key={`row-${rowIndex}`}>
                      {result.table.columns.map((column) => (
                        <td key={`${rowIndex}-${column}`}>{displayValue(row[column])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
