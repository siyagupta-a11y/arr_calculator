export type AppRole = "admin" | "sales" | "account_management" | "viewer";

export function normalizeAppRole(value: unknown): AppRole {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "admin") return "admin";
  if (normalized === "sales") return "sales";
  if (["account_management", "account management", "account-management"].includes(normalized)) {
    return "account_management";
  }
  return "viewer";
}

export function canViewCommissions(role: unknown) {
  const normalized = normalizeAppRole(role);
  return normalized === "admin" || normalized === "sales";
}

export function isSalesOnlyRole(role: unknown) {
  return normalizeAppRole(role) === "sales";
}

export function isAccountManagementOnlyRole(role: unknown) {
  return normalizeAppRole(role) === "account_management";
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

export function isAccountManagementAllowedApplicationPath(pathname: string) {
  const normalized = String(pathname || "").trim();
  return (
    normalized === "/migration" ||
    normalized.startsWith("/migration/") ||
    normalized === "/api/migration" ||
    normalized.startsWith("/api/migration/")
  );
}
