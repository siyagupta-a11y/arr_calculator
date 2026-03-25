import { createSign } from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 120;

type RequestBody = {
  projectId?: string;
  region?: string;
  jobName?: string;
};

type ServiceAccount = {
  client_email: string;
  private_key: string;
};

const TOKEN_AUDIENCE = "https://oauth2.googleapis.com/token";
const CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

function isAuthorized(req: Request) {
  if (req.headers.get("x-vercel-cron")) return true;

  const secret = process.env.CRON_SECRET;
  if (!secret) return true;

  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${secret}`;
}

function base64Url(input: Buffer | string) {
  const raw = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return raw.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function getServiceAccount(): ServiceAccount {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const rawB64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  if (!raw && !rawB64) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_JSON_BASE64");
  }
  const jsonText = raw || Buffer.from(rawB64!, "base64").toString("utf8");
  const parsed = JSON.parse(jsonText) as Partial<ServiceAccount>;
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("Service account JSON is missing client_email/private_key");
  }
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
  };
}

async function getAccessToken(serviceAccount: ServiceAccount) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: TOKEN_AUDIENCE,
    scope: CLOUD_SCOPE,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };

  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(serviceAccount.private_key);
  const assertion = `${unsigned}.${base64Url(signature)}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const response = await fetch(TOKEN_AUDIENCE, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Google token error ${response.status}: ${text}`);
  }
  const json = JSON.parse(text) as { access_token?: string };
  if (!json.access_token) throw new Error("Token response missing access_token");
  return json.access_token;
}

function resolveTarget(body: RequestBody) {
  return {
    projectId:
      String(body.projectId || "").trim() ||
      String(process.env.STRIPE_UPCOMING_SYNC_PROJECT_ID || "").trim() ||
      "botpress-stripe-data-pipeline",
    region:
      String(body.region || "").trim() ||
      String(process.env.STRIPE_UPCOMING_SYNC_REGION || "").trim() ||
      "northamerica-northeast1",
    jobName:
      String(body.jobName || "").trim() ||
      String(process.env.STRIPE_UPCOMING_SYNC_JOB || "").trim() ||
      "stripe-upcoming-line-sync",
  };
}

async function triggerCloudRunJob(projectId: string, region: string, jobName: string) {
  const serviceAccount = getServiceAccount();
  const accessToken = await getAccessToken(serviceAccount);
  const url = `https://run.googleapis.com/v2/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(region)}/jobs/${encodeURIComponent(jobName)}:run`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Cloud Run Jobs API error ${response.status}: ${text}`);
  }
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: RequestBody = {};
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    body = {};
  }

  const target = resolveTarget(body);
  const startedAt = Date.now();
  const operation = await triggerCloudRunJob(target.projectId, target.region, target.jobName);

  return NextResponse.json({
    ok: true,
    elapsedMs: Date.now() - startedAt,
    triggeredAtUtc: new Date().toISOString(),
    ...target,
    operation,
  });
}

export async function GET(req: Request) {
  try {
    return await handle(req);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    return await handle(req);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
