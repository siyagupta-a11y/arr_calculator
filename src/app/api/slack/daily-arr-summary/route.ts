import { NextResponse } from "next/server";
import { buildCombinedLiveArrPayload } from "@/lib/combinedLiveArr";

export const runtime = "nodejs";
export const maxDuration = 300;

type RequestBody = {
  dryRun?: boolean;
};

function isAuthorized(req: Request) {
  if (req.headers.get("x-vercel-cron")) return true;

  const secret = process.env.CRON_SECRET;
  if (!secret) return true;

  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${secret}`;
}

function asBool(value: unknown, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "y";
}

function formatMoney(value: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 0,
    }).format(Number(value || 0));
  } catch {
    const rounded = Math.round(Number(value || 0));
    return `${currency || "USD"} ${rounded.toLocaleString("en-US")}`;
  }
}

async function slackFetchJson(path: string, token: string, payload: Record<string, unknown>) {
  const res = await fetch(`https://slack.com/api/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { ok: false, error: `Invalid JSON response: ${text}` };
  }
  return { status: res.status, json };
}

async function resolveSlackChannelId(token: string) {
  const explicitChannel = String(process.env.SLACK_ARR_DAILY_CHANNEL_ID || "").trim();
  if (explicitChannel) return explicitChannel;

  const hanyUserId = String(process.env.SLACK_HANY_USER_ID || "").trim();
  if (!hanyUserId) {
    throw new Error("Missing SLACK_HANY_USER_ID (or set SLACK_ARR_DAILY_CHANNEL_ID)");
  }

  const opened = await slackFetchJson("conversations.open", token, { users: hanyUserId });
  if (!opened.status || opened.status < 200 || opened.status >= 300 || opened.json.ok !== true) {
    throw new Error(`Slack conversations.open failed: ${String(opened.json.error || opened.status)}`);
  }

  const channelId = String(
    (opened.json.channel as { id?: unknown } | undefined)?.id ||
      (opened.json as { channel?: unknown }).channel ||
      "",
  ).trim();
  if (!channelId) {
    throw new Error("Slack conversations.open returned no channel id");
  }
  return channelId;
}

function buildSlackText(payload: Awaited<ReturnType<typeof buildCombinedLiveArrPayload>>) {
  const currency = payload.targetCurrency || "USD";
  const asOfDate = payload.generatedAtUtc.slice(0, 10);
  return [
    `Daily ARR snapshot (${asOfDate})`,
    `Projected ARR (EOM): ${formatMoney(payload.projectedArr, currency)}`,
    `Projected ARR (EOM, Flat Adjusted): ${formatMoney(payload.projectedArrEomFlatAdjusted, currency)}`,
    `Projected ARR (EOM, Flat Flat): ${formatMoney(payload.projectedArrEomFlatFlat, currency)}`,
  ].join("\n");
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
  const dryRun = asBool(body.dryRun, false);

  const payload = await buildCombinedLiveArrPayload();
  const text = buildSlackText(payload);

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      text,
      payload,
    });
  }

  const botToken = String(process.env.SLACK_BOT_TOKEN || "").trim();
  if (!botToken) {
    throw new Error("Missing SLACK_BOT_TOKEN");
  }

  const channel = await resolveSlackChannelId(botToken);
  const posted = await slackFetchJson("chat.postMessage", botToken, {
    channel,
    text,
    mrkdwn: true,
    unfurl_links: false,
    unfurl_media: false,
  });
  if (!posted.status || posted.status < 200 || posted.status >= 300 || posted.json.ok !== true) {
    throw new Error(`Slack chat.postMessage failed: ${String(posted.json.error || posted.status)}`);
  }

  return NextResponse.json({
    ok: true,
    dryRun: false,
    channel,
    messageTs: posted.json.ts || null,
    text,
    payload,
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
