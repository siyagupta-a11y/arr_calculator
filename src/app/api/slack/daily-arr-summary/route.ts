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

type SlackTarget =
  | { kind: "channel"; channelId: string }
  | { kind: "dm"; userId: string; channelId: string };

function parseCsvList(value: string) {
  return Array.from(
    new Set(
      String(value || "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  );
}

async function openSlackDmChannel(token: string, userId: string) {
  const opened = await slackFetchJson("conversations.open", token, { users: userId });
  if (!opened.status || opened.status < 200 || opened.status >= 300 || opened.json.ok !== true) {
    throw new Error(`Slack conversations.open failed for ${userId}: ${String(opened.json.error || opened.status)}`);
  }

  const channelId = String(
    (opened.json.channel as { id?: unknown } | undefined)?.id ||
      (opened.json as { channel?: unknown }).channel ||
      "",
  ).trim();
  if (!channelId) {
    throw new Error(`Slack conversations.open returned no channel id for ${userId}`);
  }
  return channelId;
}

async function resolveSlackTargets(token: string): Promise<SlackTarget[]> {
  const explicitChannel = String(process.env.SLACK_ARR_DAILY_CHANNEL_ID || "").trim();
  if (explicitChannel) return [{ kind: "channel", channelId: explicitChannel }];

  const userIds = parseCsvList(
    String(process.env.SLACK_DAILY_USER_IDS || "").trim() ||
      String(process.env.SLACK_HANY_USER_ID || "").trim(),
  );
  if (userIds.length === 0) {
    throw new Error("Missing SLACK_DAILY_USER_IDS (or set SLACK_HANY_USER_ID / SLACK_ARR_DAILY_CHANNEL_ID)");
  }

  const targets: SlackTarget[] = [];
  for (const userId of userIds) {
    const channelId = await openSlackDmChannel(token, userId);
    targets.push({ kind: "dm", userId, channelId });
  }
  return targets;
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
    const previewTargets = (() => {
      const explicitChannel = String(process.env.SLACK_ARR_DAILY_CHANNEL_ID || "").trim();
      if (explicitChannel) return [{ kind: "channel" as const, channelId: explicitChannel }];
      const userIds = parseCsvList(
        String(process.env.SLACK_DAILY_USER_IDS || "").trim() ||
          String(process.env.SLACK_HANY_USER_ID || "").trim(),
      );
      return userIds.map((userId) => ({ kind: "dm" as const, userId }));
    })();
    return NextResponse.json({
      ok: true,
      dryRun: true,
      targets: previewTargets,
      text,
      payload,
    });
  }

  const botToken = String(process.env.SLACK_BOT_TOKEN || "").trim();
  if (!botToken) {
    throw new Error("Missing SLACK_BOT_TOKEN");
  }

  const targets = await resolveSlackTargets(botToken);
  const deliveries: Array<{
    kind: "channel" | "dm";
    channelId: string;
    userId?: string;
    messageTs?: string;
  }> = [];

  for (const target of targets) {
    const posted = await slackFetchJson("chat.postMessage", botToken, {
      channel: target.channelId,
      text,
      mrkdwn: true,
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!posted.status || posted.status < 200 || posted.status >= 300 || posted.json.ok !== true) {
      const label = target.kind === "dm" ? `user ${target.userId}` : `channel ${target.channelId}`;
      throw new Error(`Slack chat.postMessage failed for ${label}: ${String(posted.json.error || posted.status)}`);
    }
    deliveries.push({
      kind: target.kind,
      channelId: target.channelId,
      userId: target.kind === "dm" ? target.userId : undefined,
      messageTs: String(posted.json.ts || ""),
    });
  }

  return NextResponse.json({
    ok: true,
    dryRun: false,
    targets: deliveries,
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
