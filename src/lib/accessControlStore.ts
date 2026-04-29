import { BlobNotFoundError, head, put } from "@vercel/blob";
import { promises as fs } from "node:fs";
import path from "node:path";
import { blobAccessMode, blobFetchHeaders, blobReadWriteToken, hasBlobToken } from "@/lib/blobConfig";

export type AccessControlStoreStorageKind = "vercel_blob" | "local_tmp";

export type AccessControlPolicy = {
  version: 1;
  allowedEmails: string[];
  adminEmails: string[];
  updatedAt: number;
};

const STORE_BLOB_PATH =
  process.env.AUTH_ACCESS_CONTROL_BLOB_PATH || "arr/auth/access-control-v1.json";
const STORE_PATH =
  process.env.AUTH_ACCESS_CONTROL_STORE_PATH || "/tmp/arr-auth-access-control-v1.json";

const REQUIRED_ADMIN_EMAILS = ["hany.safwat@botpress.com"];
const cacheTtlMs = Math.max(5_000, Number(process.env.AUTH_ACCESS_CONTROL_CACHE_TTL_MS || "30000"));
let policyCache: { value: AccessControlPolicy; expiresAt: number } | null = null;

function normalizeEmail(raw: unknown) {
  return String(raw || "").trim().toLowerCase();
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function parseCsvEmailSet(raw: string | undefined) {
  return new Set(
    String(raw || "")
      .split(",")
      .map((value) => normalizeEmail(value))
      .filter((value) => isValidEmail(value)),
  );
}

function bootstrapAdminEmails() {
  const admins = parseCsvEmailSet(process.env.AUTH_ADMIN_EMAILS);
  for (const email of REQUIRED_ADMIN_EMAILS) admins.add(normalizeEmail(email));
  return admins;
}

function bootstrapAllowedEmails() {
  const allowed = parseCsvEmailSet(process.env.AUTH_ALLOWED_EMAILS);
  for (const email of bootstrapAdminEmails()) allowed.add(email);
  return allowed;
}

function normalizePolicy(value: unknown): AccessControlPolicy {
  const parsed = value && typeof value === "object" ? (value as Partial<AccessControlPolicy>) : {};
  const allowedSet = new Set<string>();
  const adminSet = new Set<string>();

  for (const email of parsed.allowedEmails || []) {
    const normalized = normalizeEmail(email);
    if (isValidEmail(normalized)) allowedSet.add(normalized);
  }
  for (const email of parsed.adminEmails || []) {
    const normalized = normalizeEmail(email);
    if (isValidEmail(normalized)) adminSet.add(normalized);
  }

  for (const email of bootstrapAdminEmails()) {
    adminSet.add(email);
    allowedSet.add(email);
  }
  for (const email of bootstrapAllowedEmails()) {
    allowedSet.add(email);
  }

  for (const email of adminSet) allowedSet.add(email);

  return {
    version: 1,
    allowedEmails: Array.from(allowedSet).sort((a, b) => a.localeCompare(b)),
    adminEmails: Array.from(adminSet).sort((a, b) => a.localeCompare(b)),
    updatedAt: Number(parsed.updatedAt || Date.now()),
  };
}

function parsePolicy(raw: string): AccessControlPolicy {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return normalizePolicy(parsed);
  } catch {
    return normalizePolicy(null);
  }
}

function encodePolicy(policy: AccessControlPolicy) {
  return JSON.stringify(normalizePolicy(policy));
}

function canUseBlobStorage() {
  return hasBlobToken();
}

async function loadFromBlob() {
  try {
    const token = blobReadWriteToken();
    if (!token) return normalizePolicy(null);
    const meta = await head(STORE_BLOB_PATH, { token });
    if (!meta?.url) return normalizePolicy(null);
    const res = await fetch(meta.url, {
      cache: "no-store",
      headers: blobFetchHeaders(),
    });
    if (!res.ok) return normalizePolicy(null);
    const text = await res.text();
    return parsePolicy(text);
  } catch (error: unknown) {
    if (error instanceof BlobNotFoundError) return normalizePolicy(null);
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("not found") || message.includes("404")) return normalizePolicy(null);
    throw error;
  }
}

async function saveToBlob(policy: AccessControlPolicy) {
  const token = blobReadWriteToken();
  if (!token) throw new Error("Missing blob read/write token");
  await put(STORE_BLOB_PATH, encodePolicy(policy), {
    token,
    access: blobAccessMode(),
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: "application/json",
  });
}

async function loadFromFile() {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    return parsePolicy(raw);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return normalizePolicy(null);
    throw error;
  }
}

async function saveToFile(policy: AccessControlPolicy) {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, encodePolicy(policy), "utf8");
}

async function readPolicyUncached() {
  if (canUseBlobStorage()) {
    return { storage: "vercel_blob" as const, policy: await loadFromBlob() };
  }
  return { storage: "local_tmp" as const, policy: await loadFromFile() };
}

export async function loadAccessControlPolicy(options?: { bypassCache?: boolean }): Promise<{
  storage: AccessControlStoreStorageKind;
  policy: AccessControlPolicy;
}> {
  const bypassCache = options?.bypassCache === true;
  if (!bypassCache && policyCache && policyCache.expiresAt > Date.now()) {
    return { storage: canUseBlobStorage() ? "vercel_blob" : "local_tmp", policy: policyCache.value };
  }
  const loaded = await readPolicyUncached();
  policyCache = {
    value: loaded.policy,
    expiresAt: Date.now() + cacheTtlMs,
  };
  return loaded;
}

export async function saveAccessControlPolicy(policy: AccessControlPolicy): Promise<{
  storage: AccessControlStoreStorageKind;
  policy: AccessControlPolicy;
}> {
  const normalized = normalizePolicy({
    ...policy,
    updatedAt: Date.now(),
  });
  if (canUseBlobStorage()) {
    await saveToBlob(normalized);
    policyCache = { value: normalized, expiresAt: Date.now() + cacheTtlMs };
    return { storage: "vercel_blob", policy: normalized };
  }
  await saveToFile(normalized);
  policyCache = { value: normalized, expiresAt: Date.now() + cacheTtlMs };
  return { storage: "local_tmp", policy: normalized };
}

export async function upsertAccessEmail(email: string, isAdmin: boolean) {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) {
    throw new Error("Invalid email address");
  }
  const loaded = await loadAccessControlPolicy({ bypassCache: true });
  const allowed = new Set(loaded.policy.allowedEmails);
  const admins = new Set(loaded.policy.adminEmails);
  allowed.add(normalized);
  if (isAdmin) admins.add(normalized);
  return saveAccessControlPolicy({
    version: 1,
    allowedEmails: Array.from(allowed),
    adminEmails: Array.from(admins),
    updatedAt: Date.now(),
  });
}

export async function setEmailAdmin(email: string, isAdmin: boolean) {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) {
    throw new Error("Invalid email address");
  }
  const loaded = await loadAccessControlPolicy({ bypassCache: true });
  const allowed = new Set(loaded.policy.allowedEmails);
  const admins = new Set(loaded.policy.adminEmails);
  if (isAdmin) {
    allowed.add(normalized);
    admins.add(normalized);
  } else {
    admins.delete(normalized);
    for (const required of bootstrapAdminEmails()) admins.add(required);
    if (!admins.size) {
      throw new Error("Cannot remove the last admin");
    }
  }
  return saveAccessControlPolicy({
    version: 1,
    allowedEmails: Array.from(allowed),
    adminEmails: Array.from(admins),
    updatedAt: Date.now(),
  });
}

export async function removeAccessEmail(email: string) {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) {
    throw new Error("Invalid email address");
  }
  const requiredAdmins = bootstrapAdminEmails();
  if (requiredAdmins.has(normalized)) {
    throw new Error("Cannot remove a required admin email");
  }
  const loaded = await loadAccessControlPolicy({ bypassCache: true });
  const allowed = new Set(loaded.policy.allowedEmails);
  const admins = new Set(loaded.policy.adminEmails);
  allowed.delete(normalized);
  admins.delete(normalized);
  for (const required of requiredAdmins) {
    allowed.add(required);
    admins.add(required);
  }
  return saveAccessControlPolicy({
    version: 1,
    allowedEmails: Array.from(allowed),
    adminEmails: Array.from(admins),
    updatedAt: Date.now(),
  });
}

