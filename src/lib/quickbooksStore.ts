import { BlobNotFoundError, head, put } from "@vercel/blob";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { blobAccessMode, blobFetchHeaders, blobReadWriteToken, hasBlobToken } from "@/lib/blobConfig";

export type QuickBooksStorageKind = "vercel_blob" | "local_tmp";

export type QuickBooksConnection = {
  realmId: string;
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  scope: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number;
  connectedAt: number;
  updatedAt: number;
};

type QuickBooksConnectionStoreV2 = {
  version: 2;
  connections: QuickBooksConnection[];
};

const STORE_BLOB_PATH = process.env.QUICKBOOKS_TOKEN_BLOB_PATH || "arr/quickbooks/tokens-v1.json";
const STORE_PATH = process.env.QUICKBOOKS_TOKEN_STORE_PATH || "/tmp/arr-quickbooks-tokens-v1.json";
const ENCRYPTION_ALGO = "aes-256-gcm";

type EncryptedConnectionEnvelope = {
  version: 1;
  alg: typeof ENCRYPTION_ALGO;
  iv: string;
  tag: string;
  data: string;
};

function canUseBlobStorage() {
  return hasBlobToken();
}

function quickBooksEncryptionSecret() {
  for (const name of [
    "QUICKBOOKS_TOKEN_ENCRYPTION_KEY",
    "QUICKBOOKS_CLIENT_SECRET",
    "INTUIT_CLIENT_SECRET",
    "QB_CLIENT_SECRET",
    "CLIENT_SECRET",
  ]) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function deriveEncryptionKey(): Buffer | null {
  const secret = quickBooksEncryptionSecret();
  if (!secret) return null;
  return createHash("sha256").update(secret, "utf8").digest();
}

function isEncryptedEnvelope(value: unknown): value is EncryptedConnectionEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<EncryptedConnectionEnvelope>;
  return (
    candidate.version === 1 &&
    candidate.alg === ENCRYPTION_ALGO &&
    typeof candidate.iv === "string" &&
    typeof candidate.tag === "string" &&
    typeof candidate.data === "string"
  );
}

function decodeConnection(value: unknown): QuickBooksConnection | null {
  if (!value || typeof value !== "object") return null;
  const parsed = value as Partial<QuickBooksConnection>;
  if (
    typeof parsed.realmId !== "string" ||
    typeof parsed.accessToken !== "string" ||
    typeof parsed.refreshToken !== "string" ||
    typeof parsed.tokenType !== "string" ||
    typeof parsed.scope !== "string" ||
    typeof parsed.accessTokenExpiresAt !== "number" ||
    typeof parsed.refreshTokenExpiresAt !== "number" ||
    typeof parsed.connectedAt !== "number" ||
    typeof parsed.updatedAt !== "number"
  ) {
    return null;
  }
  return parsed as QuickBooksConnection;
}

function normalizeConnections(connections: QuickBooksConnection[]) {
  const byRealm = new Map<string, QuickBooksConnection>();
  for (const connection of connections) {
    const normalized = decodeConnection(connection);
    if (!normalized) continue;
    const realmId = String(normalized.realmId || "").trim();
    if (!realmId) continue;
    const existing = byRealm.get(realmId);
    if (!existing || Number(normalized.updatedAt || 0) >= Number(existing.updatedAt || 0)) {
      byRealm.set(realmId, { ...normalized, realmId });
    }
  }
  return Array.from(byRealm.values()).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

function decodeConnections(value: unknown): QuickBooksConnection[] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return normalizeConnections(value as QuickBooksConnection[]);
  }
  if (typeof value === "object") {
    const candidate = value as Partial<QuickBooksConnectionStoreV2> & Partial<QuickBooksConnection>;
    if (candidate.version === 2 && Array.isArray(candidate.connections)) {
      return normalizeConnections(candidate.connections as QuickBooksConnection[]);
    }
  }
  const single = decodeConnection(value);
  return single ? [single] : [];
}

function decryptEnvelope(envelope: EncryptedConnectionEnvelope) {
  const key = deriveEncryptionKey();
  if (!key) return null;
  try {
    const decipher = createDecipheriv(
      ENCRYPTION_ALGO,
      key,
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(decrypted) as unknown;
  } catch {
    return null;
  }
}

function encodeConnections(connections: QuickBooksConnection[], requireEncryption: boolean) {
  const payload: QuickBooksConnectionStoreV2 = {
    version: 2,
    connections: normalizeConnections(connections),
  };
  const plaintext = JSON.stringify(payload);
  const key = deriveEncryptionKey();
  if (!key) {
    if (requireEncryption) {
      throw new Error(
        "Missing QuickBooks token encryption secret. Set QUICKBOOKS_TOKEN_ENCRYPTION_KEY or QUICKBOOKS_CLIENT_SECRET.",
      );
    }
    return plaintext;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv(ENCRYPTION_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope: EncryptedConnectionEnvelope = {
    version: 1,
    alg: ENCRYPTION_ALGO,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  };
  return JSON.stringify(envelope);
}

function parseConnections(raw: string): QuickBooksConnection[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null) return [];
    if (isEncryptedEnvelope(parsed)) {
      const decrypted = decryptEnvelope(parsed);
      return decodeConnections(decrypted);
    }
    return decodeConnections(parsed);
  } catch {
    return [];
  }
}

async function loadConnectionFromBlob() {
  try {
    const token = blobReadWriteToken();
    if (!token) return [];
    const meta = await head(STORE_BLOB_PATH, { token });
    if (!meta?.url) return [];

    const res = await fetch(meta.url, {
      cache: "no-store",
      headers: blobFetchHeaders(),
    });
    if (!res.ok) return [];
    const text = await res.text();
    return parseConnections(text);
  } catch (error: unknown) {
    if (error instanceof BlobNotFoundError) return [];
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("not found") || message.includes("404")) {
      return [];
    }
    throw error;
  }
}

async function saveConnectionToBlob(connections: QuickBooksConnection[]) {
  const token = blobReadWriteToken();
  if (!token) throw new Error("Missing blob read/write token");
  await put(STORE_BLOB_PATH, encodeConnections(connections, true), {
    token,
    access: blobAccessMode(),
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: "application/json",
  });
}

async function loadConnectionFromLocalFile() {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    return parseConnections(raw);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
}

async function saveConnectionToLocalFile(connections: QuickBooksConnection[]) {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, encodeConnections(connections, false), "utf8");
}

export function quickBooksStorageKind(): QuickBooksStorageKind {
  return canUseBlobStorage() ? "vercel_blob" : "local_tmp";
}

export async function loadQuickBooksConnection(): Promise<{
  connection: QuickBooksConnection | null;
  storage: QuickBooksStorageKind;
}> {
  const loaded = await loadQuickBooksConnections();
  return {
    connection: loaded.connections[0] || null,
    storage: loaded.storage,
  };
}

export async function loadQuickBooksConnections(): Promise<{
  connections: QuickBooksConnection[];
  storage: QuickBooksStorageKind;
}> {
  if (canUseBlobStorage()) {
    const connections = await loadConnectionFromBlob();
    return { connections, storage: "vercel_blob" };
  }
  const connections = await loadConnectionFromLocalFile();
  return { connections, storage: "local_tmp" };
}

export async function saveQuickBooksConnection(connection: QuickBooksConnection) {
  const loaded = await loadQuickBooksConnections();
  const nextConnections = normalizeConnections([connection, ...(loaded.connections || [])]);
  if (canUseBlobStorage()) {
    await saveConnectionToBlob(nextConnections);
    return;
  }
  await saveConnectionToLocalFile(nextConnections);
}

export async function clearQuickBooksConnection() {
  if (canUseBlobStorage()) {
    await saveConnectionToBlob([]);
    return;
  }
  try {
    await fs.unlink(STORE_PATH);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw error;
  }
}
