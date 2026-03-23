const TOKEN_ENV_KEYS = [
  "ARRP_READ_WRITE_TOKEN",
  "AARP_READ_WRITE_TOKEN",
  "BLOB_READ_WRITE_TOKEN",
] as const;

export function blobReadWriteToken(): string {
  for (const key of TOKEN_ENV_KEYS) {
    const value = String(process.env[key] || "").trim();
    if (value) return value;
  }
  return "";
}

export function hasBlobToken(): boolean {
  return Boolean(blobReadWriteToken());
}

export function blobAccessMode(): "public" | "private" {
  const raw = String(process.env.BLOB_STORE_ACCESS || "private").trim().toLowerCase();
  return raw === "public" ? "public" : "private";
}

export function blobFetchHeaders() {
  const token = blobReadWriteToken();
  if (!token) return undefined;
  return { Authorization: `Bearer ${token}` };
}
