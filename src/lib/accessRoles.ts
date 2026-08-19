export type AppRole = "admin" | "sales" | "viewer";

export function normalizeAppRole(value: unknown): AppRole {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "admin") return "admin";
  if (normalized === "sales") return "sales";
  return "viewer";
}

export function canViewCommissions(role: unknown) {
  const normalized = normalizeAppRole(role);
  return normalized === "admin" || normalized === "sales";
}

export function isSalesOnlyRole(role: unknown) {
  return normalizeAppRole(role) === "sales";
}

export function isSalesAllowedApplicationPath(pathname: string) {
  const normalized = String(pathname || "").trim();
  return (
    normalized === "/commissions" ||
    normalized.startsWith("/commissions/") ||
    normalized === "/api/commissions" ||
    normalized.startsWith("/api/commissions/")
  );
}
