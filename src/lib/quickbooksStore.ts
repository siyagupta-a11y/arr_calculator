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

function encodeConnection(connection: QuickBooksConnection | null, requireEncryption: boolean) {
  const plaintext = JSON.stringify(connection);
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

function parseConnection(raw: string): QuickBooksConnection | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null) return null;
    if (isEncryptedEnvelope(parsed)) {
      const decrypted = decryptEnvelope(parsed);
      return decodeConnection(decrypted);
    }
    return decodeConnection(parsed);
  } catch {
    return null;
  }
}

async function loadConnectionFromBlob() {
  try {
    const token = blobReadWriteToken();
    if (!token) return null;
    const meta = await head(STORE_BLOB_PATH, { token });
    if (!meta?.url) return null;

    const res = await fetch(meta.url, {
      cache: "no-store",
      headers: blobFetchHeaders(),
    });
    if (!res.ok) return null;
    const text = await res.text();
    return parseConnection(text);
  } catch (error: unknown) {
    if (error instanceof BlobNotFoundError) return null;
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("not found") || message.includes("404")) {
      return null;
    }
    throw error;
  }
}

async function saveConnectionToBlob(connection: QuickBooksConnection | null) {
  const token = blobReadWriteToken();
  if (!token) throw new Error("Missing blob read/write token");
  await put(STORE_BLOB_PATH, encodeConnection(connection, true), {
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
    return parseConnection(raw);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

async function saveConnectionToLocalFile(connection: QuickBooksConnection | null) {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, encodeConnection(connection, false), "utf8");
}

export function quickBooksStorageKind(): QuickBooksStorageKind {
  return canUseBlobStorage() ? "vercel_blob" : "local_tmp";
}

export async function loadQuickBooksConnection(): Promise<{
  connection: QuickBooksConnection | null;
  storage: QuickBooksStorageKind;
}> {
  if (canUseBlobStorage()) {
    const connection = await loadConnectionFromBlob();
    return { connection, storage: "vercel_blob" };
  }
  const connection = await loadConnectionFromLocalFile();
  return { connection, storage: "local_tmp" };
}

export async function saveQuickBooksConnection(connection: QuickBooksConnection) {
  if (canUseBlobStorage()) {
    await saveConnectionToBlob(connection);
    return;
  }
  await saveConnectionToLocalFile(connection);
}

export async function clearQuickBooksConnection() {
  if (canUseBlobStorage()) {
    await saveConnectionToBlob(null);
    return;
  }
  try {
    await fs.unlink(STORE_PATH);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw error;
  }
}
