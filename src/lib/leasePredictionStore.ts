import { BlobNotFoundError, del, head, put } from "@vercel/blob";
import { promises as fs } from "node:fs";
import path from "node:path";
import { blobAccessMode, blobFetchHeaders, blobReadWriteToken, hasBlobToken } from "@/lib/blobConfig";

export type LeasePredictionStorageKind = "vercel_blob" | "local_tmp";

export type LeasePredictionTerms = {
  leaseStartDate: string;
  leaseEndDate: string;
  monthlyExpense: number;
  annualEscalationPct: number;
  confidence: number;
  summary: string;
  extractionSource: "heuristic_pdf" | "manual";
};

export type LeaseDocumentRecord = {
  id: string;
  fileName: string;
  contentType: string;
  fileSizeBytes: number;
  uploadedAtUtc: string;
  updatedAtUtc: string;
  uploadedByEmail: string;
  filePath: string;
  extractedTextPreview: string;
  terms: LeasePredictionTerms;
};

type LeaseDocumentStoreV1 = {
  version: 1;
  documents: LeaseDocumentRecord[];
};

const STORE_BLOB_PATH = process.env.LEASE_PREDICTION_INDEX_BLOB_PATH || "arr/lease-prediction/index-v1.json";
const STORE_LOCAL_PATH = process.env.LEASE_PREDICTION_INDEX_LOCAL_PATH || "/tmp/arr-lease-prediction/index-v1.json";
const FILE_BLOB_PREFIX = process.env.LEASE_PREDICTION_FILES_BLOB_PREFIX || "arr/lease-prediction/files";
const FILE_LOCAL_DIR = process.env.LEASE_PREDICTION_FILES_LOCAL_DIR || "/tmp/arr-lease-prediction/files";

function nowIsoUtc() {
  return new Date().toISOString();
}

function sanitizeFilename(name: string) {
  const cleaned = String(name || "lease.pdf")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "lease.pdf";
}

function normalizeDate(value: unknown) {
  const v = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "";
}

function normalizeNumber(value: unknown, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function normalizeTerms(value: unknown): LeasePredictionTerms {
  const parsed = value && typeof value === "object" ? (value as Partial<LeasePredictionTerms>) : {};
  return {
    leaseStartDate: normalizeDate(parsed.leaseStartDate),
    leaseEndDate: normalizeDate(parsed.leaseEndDate),
    monthlyExpense: Math.max(0, normalizeNumber(parsed.monthlyExpense, 0)),
    annualEscalationPct: Math.max(0, normalizeNumber(parsed.annualEscalationPct, 0)),
    confidence: Math.max(0, Math.min(1, normalizeNumber(parsed.confidence, 0))),
    summary: String(parsed.summary || "").trim(),
    extractionSource: parsed.extractionSource === "manual" ? "manual" : "heuristic_pdf",
  };
}

function normalizeRecord(value: unknown): LeaseDocumentRecord | null {
  if (!value || typeof value !== "object") return null;
  const parsed = value as Partial<LeaseDocumentRecord>;
  const id = String(parsed.id || "").trim();
  if (!id) return null;
  const filePath = String(parsed.filePath || "").trim();
  if (!filePath) return null;
  return {
    id,
    fileName: String(parsed.fileName || "lease.pdf").trim() || "lease.pdf",
    contentType: String(parsed.contentType || "application/pdf").trim() || "application/pdf",
    fileSizeBytes: Math.max(0, Math.floor(Number(parsed.fileSizeBytes || 0))),
    uploadedAtUtc: String(parsed.uploadedAtUtc || nowIsoUtc()).trim() || nowIsoUtc(),
    updatedAtUtc: String(parsed.updatedAtUtc || nowIsoUtc()).trim() || nowIsoUtc(),
    uploadedByEmail: String(parsed.uploadedByEmail || "").trim(),
    filePath,
    extractedTextPreview: String(parsed.extractedTextPreview || "").trim(),
    terms: normalizeTerms(parsed.terms),
  };
}

function normalizeStore(raw: unknown): LeaseDocumentStoreV1 {
  const parsed = raw && typeof raw === "object" ? (raw as Partial<LeaseDocumentStoreV1>) : {};
  const docs = Array.isArray(parsed.documents)
    ? parsed.documents.map((item) => normalizeRecord(item)).filter((item): item is LeaseDocumentRecord => !!item)
    : [];
  docs.sort((a, b) => b.uploadedAtUtc.localeCompare(a.uploadedAtUtc));
  return {
    version: 1,
    documents: docs,
  };
}

function encodeStore(store: LeaseDocumentStoreV1) {
  return JSON.stringify(normalizeStore(store));
}

function parseStore(raw: string) {
  try {
    return normalizeStore(JSON.parse(raw));
  } catch {
    return normalizeStore(null);
  }
}

function canUseBlobStorage() {
  return hasBlobToken();
}

async function loadStoreFromBlob() {
  try {
    const token = blobReadWriteToken();
    if (!token) return normalizeStore(null);
    const meta = await head(STORE_BLOB_PATH, { token });
    if (!meta?.url) return normalizeStore(null);
    const res = await fetch(meta.url, {
      cache: "no-store",
      headers: blobFetchHeaders(),
    });
    if (!res.ok) return normalizeStore(null);
    const text = await res.text();
    return parseStore(text);
  } catch (error: unknown) {
    if (error instanceof BlobNotFoundError) return normalizeStore(null);
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("not found") || message.includes("404")) return normalizeStore(null);
    throw error;
  }
}

async function saveStoreToBlob(store: LeaseDocumentStoreV1) {
  const token = blobReadWriteToken();
  if (!token) throw new Error("Missing blob read/write token");
  await put(STORE_BLOB_PATH, encodeStore(store), {
    token,
    access: blobAccessMode(),
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: "application/json",
  });
}

async function loadStoreFromLocal() {
  try {
    const raw = await fs.readFile(STORE_LOCAL_PATH, "utf8");
    return parseStore(raw);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return normalizeStore(null);
    throw error;
  }
}

async function saveStoreToLocal(store: LeaseDocumentStoreV1) {
  await fs.mkdir(path.dirname(STORE_LOCAL_PATH), { recursive: true });
  await fs.writeFile(STORE_LOCAL_PATH, encodeStore(store), "utf8");
}

async function loadStore() {
  if (canUseBlobStorage()) {
    const store = await loadStoreFromBlob();
    return { storage: "vercel_blob" as const, store };
  }
  const store = await loadStoreFromLocal();
  return { storage: "local_tmp" as const, store };
}

async function saveStore(store: LeaseDocumentStoreV1) {
  const normalized = normalizeStore(store);
  if (canUseBlobStorage()) {
    await saveStoreToBlob(normalized);
    return "vercel_blob" as const;
  }
  await saveStoreToLocal(normalized);
  return "local_tmp" as const;
}

function safeDecodePdfString(input: string) {
  let out = "";
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = input[i + 1] || "";
    if (next === "n") {
      out += "\n";
      i += 1;
      continue;
    }
    if (next === "r") {
      out += "\r";
      i += 1;
      continue;
    }
    if (next === "t") {
      out += "\t";
      i += 1;
      continue;
    }
    if (next === "b") {
      out += "\b";
      i += 1;
      continue;
    }
    if (next === "f") {
      out += "\f";
      i += 1;
      continue;
    }
    if (next === "(" || next === ")" || next === "\\") {
      out += next;
      i += 1;
      continue;
    }
    if (/[0-7]/.test(next)) {
      let oct = next;
      if (/[0-7]/.test(input[i + 2] || "")) oct += input[i + 2];
      if (/[0-7]/.test(input[i + 3] || "")) oct += input[i + 3];
      out += String.fromCharCode(parseInt(oct, 8));
      i += oct.length;
      continue;
    }
    out += next;
    i += 1;
  }
  return out;
}

function extractLikelyTextFromPdf(buffer: Buffer) {
  const raw = buffer.toString("latin1");
  const chunks: string[] = [];

  const parenMatches = raw.match(/\((?:\\.|[^\\()])+\)/g) || [];
  for (const token of parenMatches) {
    const inner = token.slice(1, -1);
    const decoded = safeDecodePdfString(inner).replace(/\s+/g, " ").trim();
    if (decoded.length >= 3) chunks.push(decoded);
  }

  const asciiMatches = raw.match(/[A-Za-z0-9$%.,\-/:;() ]{8,}/g) || [];
  for (const token of asciiMatches) {
    const cleaned = token.replace(/\s+/g, " ").trim();
    if (cleaned.length >= 8) chunks.push(cleaned);
  }

  const deduped = Array.from(new Set(chunks));
  return deduped.join("\n").slice(0, 120_000);
}

function toIsoFromDateCandidate(raw: string) {
  const s = String(raw || "").trim();
  if (!s) return "";

  const ymd = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (ymd) {
    const y = Number(ymd[1]);
    const m = Number(ymd[2]);
    const d = Number(ymd[3]);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d) {
      return dt.toISOString().slice(0, 10);
    }
  }

  const mdy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/.exec(s);
  if (mdy) {
    const m = Number(mdy[1]);
    const d = Number(mdy[2]);
    const yearRaw = Number(mdy[3]);
    const y = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d) {
      return dt.toISOString().slice(0, 10);
    }
  }

  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  return "";
}

function extractTermsFromText(text: string, fallbackFileName: string): LeasePredictionTerms {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const joined = lines.join("\n");

  const dateRegex = /(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{2,4})/gi;
  const datesFound = Array.from(new Set((joined.match(dateRegex) || []).map((d) => toIsoFromDateCandidate(d)).filter(Boolean)));
  datesFound.sort((a, b) => a.localeCompare(b));

  let leaseStartDate = "";
  let leaseEndDate = "";

  const startLine = lines.find((line) => /(commencement|start\s+date|lease\s+start|effective\s+date)/i.test(line));
  if (startLine) {
    const match = startLine.match(dateRegex);
    if (match?.[0]) leaseStartDate = toIsoFromDateCandidate(match[0]);
  }
  const endLine = lines.find((line) => /(expiration|expiry|end\s+date|lease\s+end|termination\s+date)/i.test(line));
  if (endLine) {
    const match = endLine.match(dateRegex);
    if (match?.[0]) leaseEndDate = toIsoFromDateCandidate(match[0]);
  }
  if (!leaseStartDate) leaseStartDate = datesFound[0] || "";
  if (!leaseEndDate) leaseEndDate = datesFound[1] || datesFound[0] || "";

  let monthlyExpense = 0;
  let annualEscalationPct = 0;

  const amountRegex = /\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.\d{1,2})?|[0-9]+(?:\.\d{1,2})?)/g;
  const amountCandidates: number[] = [];
  for (const line of lines) {
    if (!/(monthly|month|base\s+rent|rent\s+amount|fixed\s+rent|minimum\s+rent)/i.test(line)) continue;
    let m: RegExpExecArray | null;
    while ((m = amountRegex.exec(line)) !== null) {
      const value = Number(String(m[1] || "").replace(/,/g, ""));
      if (Number.isFinite(value) && value > 0) amountCandidates.push(value);
    }
  }
  if (!amountCandidates.length) {
    let m: RegExpExecArray | null;
    while ((m = amountRegex.exec(joined)) !== null) {
      const value = Number(String(m[1] || "").replace(/,/g, ""));
      if (Number.isFinite(value) && value >= 100) amountCandidates.push(value);
    }
  }
  if (amountCandidates.length) {
    monthlyExpense = amountCandidates[0];
  }

  const escalationLine = lines.find((line) => /(escalat|increase|cpi|annual\s+adjust)/i.test(line) && /%/.test(line));
  if (escalationLine) {
    const pct = /(\d+(?:\.\d+)?)\s*%/.exec(escalationLine);
    if (pct) annualEscalationPct = Math.max(0, Number(pct[1] || 0));
  }

  let confidence = 0.35;
  if (leaseStartDate) confidence += 0.2;
  if (leaseEndDate) confidence += 0.2;
  if (monthlyExpense > 0) confidence += 0.2;
  if (annualEscalationPct > 0) confidence += 0.05;
  confidence = Math.max(0, Math.min(0.95, confidence));

  const shortSummary = [
    fallbackFileName,
    leaseStartDate ? `start ${leaseStartDate}` : "start unknown",
    leaseEndDate ? `end ${leaseEndDate}` : "end unknown",
    monthlyExpense > 0 ? `monthly ${monthlyExpense.toFixed(2)}` : "monthly unknown",
    annualEscalationPct > 0 ? `escalation ${annualEscalationPct.toFixed(2)}%` : "no escalation found",
  ].join(" | ");

  return {
    leaseStartDate,
    leaseEndDate,
    monthlyExpense,
    annualEscalationPct,
    confidence,
    summary: shortSummary,
    extractionSource: "heuristic_pdf",
  };
}

async function saveFileBlob(pathname: string, data: Buffer, contentType: string) {
  const token = blobReadWriteToken();
  if (!token) throw new Error("Missing blob read/write token");
  await put(pathname, data, {
    token,
    access: blobAccessMode(),
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType,
  });
}

async function saveFileLocal(filePath: string, data: Buffer) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, data);
}

async function deleteFileBlob(pathname: string) {
  const token = blobReadWriteToken();
  if (!token) return;
  await del(pathname, { token });
}

async function deleteFileLocal(filePath: string) {
  try {
    await fs.unlink(filePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
}

async function readFileBlob(pathname: string): Promise<Buffer | null> {
  try {
    const token = blobReadWriteToken();
    if (!token) return null;
    const meta = await head(pathname, { token });
    if (!meta?.url) return null;
    const res = await fetch(meta.url, {
      cache: "no-store",
      headers: blobFetchHeaders(),
    });
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error: unknown) {
    if (error instanceof BlobNotFoundError) return null;
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("not found") || message.includes("404")) return null;
    throw error;
  }
}

async function readFileLocal(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

export async function listLeaseDocuments() {
  const loaded = await loadStore();
  return {
    storage: loaded.storage,
    documents: loaded.store.documents,
  };
}

export async function createLeaseDocument(args: {
  fileName: string;
  contentType: string;
  fileBytes: Buffer;
  uploadedByEmail?: string;
}) {
  const loaded = await loadStore();
  const id = `lease_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const safeName = sanitizeFilename(args.fileName || "lease.pdf");
  const ext = path.extname(safeName) || ".pdf";
  const filePath = canUseBlobStorage()
    ? `${String(FILE_BLOB_PREFIX).replace(/\/+$/g, "")}/${id}${ext}`
    : path.join(FILE_LOCAL_DIR, `${id}${ext}`);

  if (canUseBlobStorage()) {
    await saveFileBlob(filePath, args.fileBytes, args.contentType || "application/pdf");
  } else {
    await saveFileLocal(filePath, args.fileBytes);
  }

  const extractedText = extractLikelyTextFromPdf(args.fileBytes);
  const terms = extractTermsFromText(extractedText, safeName);
  const now = nowIsoUtc();

  const record: LeaseDocumentRecord = {
    id,
    fileName: safeName,
    contentType: args.contentType || "application/pdf",
    fileSizeBytes: args.fileBytes.byteLength,
    uploadedAtUtc: now,
    updatedAtUtc: now,
    uploadedByEmail: String(args.uploadedByEmail || "").trim(),
    filePath,
    extractedTextPreview: extractedText.slice(0, 3_000),
    terms,
  };

  const nextStore = normalizeStore({
    version: 1,
    documents: [record, ...loaded.store.documents],
  });
  const storage = await saveStore(nextStore);
  return { storage, document: record };
}

export async function updateLeaseDocumentTerms(documentId: string, patch: Partial<LeasePredictionTerms>) {
  const id = String(documentId || "").trim();
  if (!id) throw new Error("Missing document id");
  const loaded = await loadStore();
  const index = loaded.store.documents.findIndex((doc) => doc.id === id);
  if (index < 0) throw new Error("Document not found");

  const existing = loaded.store.documents[index];
  const nextTerms = normalizeTerms({
    ...existing.terms,
    ...patch,
    extractionSource: "manual",
  });

  const nextRecord: LeaseDocumentRecord = {
    ...existing,
    terms: nextTerms,
    updatedAtUtc: nowIsoUtc(),
  };

  const nextDocs = [...loaded.store.documents];
  nextDocs[index] = nextRecord;
  const nextStore = normalizeStore({ version: 1, documents: nextDocs });
  const storage = await saveStore(nextStore);
  return { storage, document: nextRecord };
}

export async function deleteLeaseDocument(documentId: string) {
  const id = String(documentId || "").trim();
  if (!id) throw new Error("Missing document id");
  const loaded = await loadStore();
  const existing = loaded.store.documents.find((doc) => doc.id === id);
  if (!existing) throw new Error("Document not found");

  if (canUseBlobStorage()) {
    await deleteFileBlob(existing.filePath);
  } else {
    await deleteFileLocal(existing.filePath);
  }

  const nextStore = normalizeStore({
    version: 1,
    documents: loaded.store.documents.filter((doc) => doc.id !== id),
  });
  const storage = await saveStore(nextStore);
  return { storage, deletedId: id };
}

export async function readLeaseDocumentFile(documentId: string) {
  const id = String(documentId || "").trim();
  if (!id) throw new Error("Missing document id");
  const loaded = await loadStore();
  const existing = loaded.store.documents.find((doc) => doc.id === id);
  if (!existing) throw new Error("Document not found");

  const fileBuffer = canUseBlobStorage()
    ? await readFileBlob(existing.filePath)
    : await readFileLocal(existing.filePath);
  if (!fileBuffer) throw new Error("File not found");

  return {
    fileName: existing.fileName,
    contentType: existing.contentType || "application/pdf",
    data: fileBuffer,
  };
}
