function parseFlag(value: string | undefined, fallback: boolean) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "y") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "n") return false;
  return fallback;
}

export function factTableGlobalEnabled() {
  return parseFlag(process.env.USE_FACT_TABLES_GLOBAL, false);
}

export function factTableEnabledForPage(pageKey: string) {
  const normalized = String(pageKey || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  if (!normalized) return factTableGlobalEnabled();
  const specific = process.env[`USE_FACT_TABLES_${normalized}`];
  if (specific !== undefined) return parseFlag(specific, factTableGlobalEnabled());
  return factTableGlobalEnabled();
}

export function factSyncInMainSyncEnabled() {
  return parseFlag(process.env.ENABLE_FACT_SYNC_IN_MAIN_SYNC, true);
}

export function legacyPrecomputeWarmupEnabled() {
  return parseFlag(process.env.ENABLE_LEGACY_PRECOMPUTE_WARMUP, true);
}
