/**
 * In-process Telegram long-poller (HMR-safe singleton).
 *
 * ALL state lives on `globalThis` so that HMR (hot module reload) in the dev
 * server does NOT reset it. Without this, every file edit would start a NEW
 * poller loop (since the module-scoped `started` flag resets to false on reload),
 * resulting in multiple pollers processing the same Telegram update → duplicate
 * bot responses.
 *
 * Pattern: same as how Prisma client is singleton'd in `db.ts`.
 */

import { TELEGRAM_API_BASE, TELEGRAM_BOT_TOKEN } from "./telegram";
import { autoRestoreIfEmpty, backupDailyIfDue } from "./backup";

const WEBHOOK_URL = "http://localhost:3000/api/telegram/webhook";

// ============================================================
// ALL poller state lives on globalThis — survives HMR reloads.
// ============================================================
type PollerGlobal = {
  __pollerStarted?: boolean;
  __pollerIsLooping?: boolean;
  __pollerLastUpdateId?: number;
  __pollerPollCount?: number;
  __pollerLastPollAt?: number | null;
  __pollerLastError?: string | null;
  __pollerStartedAt?: number | null;
};

const g = globalThis as unknown as PollerGlobal;

// Initialize defaults (only sets if not already set)
if (g.__pollerStarted === undefined) g.__pollerStarted = false;
if (g.__pollerIsLooping === undefined) g.__pollerIsLooping = false;
if (g.__pollerLastUpdateId === undefined) g.__pollerLastUpdateId = 0;
if (g.__pollerPollCount === undefined) g.__pollerPollCount = 0;
if (g.__pollerLastPollAt === undefined) g.__pollerLastPollAt = null;
if (g.__pollerLastError === undefined) g.__pollerLastError = null;
if (g.__pollerStartedAt === undefined) g.__pollerStartedAt = null;

export type PollerStatus = {
  started: boolean;
  isLooping: boolean;
  lastUpdateId: number;
  pollCount: number;
  lastPollAt: string | null;
  lastError: string | null;
  startedAt: string | null;
  uptimeSec: number | null;
};

export function getPollerStatus(): PollerStatus {
  return {
    started: g.__pollerStarted ?? false,
    isLooping: g.__pollerIsLooping ?? false,
    lastUpdateId: g.__pollerLastUpdateId ?? 0,
    pollCount: g.__pollerPollCount ?? 0,
    lastPollAt: g.__pollerLastPollAt ? new Date(g.__pollerLastPollAt).toISOString() : null,
    lastError: g.__pollerLastError ?? null,
    startedAt: g.__pollerStartedAt ? new Date(g.__pollerStartedAt).toISOString() : null,
    uptimeSec: g.__pollerStartedAt ? Math.round((Date.now() - g.__pollerStartedAt) / 1000) : null,
  };
}

async function tgCall(method: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`${TELEGRAM_API_BASE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollOnce(): Promise<void> {
  g.__pollerPollCount = (g.__pollerPollCount ?? 0) + 1;
  g.__pollerLastPollAt = Date.now();

  // Take a daily DB snapshot if we haven't already today (cheap no-op otherwise)
  void backupDailyIfDue();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);

  try {
    const offset = (g.__pollerLastUpdateId ?? 0) + 1;
    const url = `${TELEGRAM_API_BASE}/getUpdates?offset=${offset}&timeout=30&allowed_updates=${encodeURIComponent('["message","callback_query"]')}`;
    const res = await fetch(url, { signal: controller.signal });
    const data = await res.json();

    if (!data.ok) {
      g.__pollerLastError = `getUpdates error: ${JSON.stringify(data)}`;
      console.error("[poller]", g.__pollerLastError);
      await sleep(2000);
      return;
    }

    const updates = data.result || [];
    for (const update of updates) {
      try {
        const fwd = await fetch(WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update),
        });
        const fwdData = await fwd.json();
        console.log(
          `[poller] update ${update.update_id} dispatched → ${fwd.status} ${JSON.stringify(fwdData).slice(0, 150)}`
        );
      } catch (e) {
        console.error(`[poller] update ${update.update_id} dispatch failed:`, e);
      }
      g.__pollerLastUpdateId = Math.max(g.__pollerLastUpdateId ?? 0, update.update_id);
    }

    if (updates.length > 0) {
      console.log(`[poller] Processed ${updates.length} update(s). Last update_id: ${g.__pollerLastUpdateId}`);
    }
    g.__pollerLastError = null;
  } catch (e: unknown) {
    if ((e as Error)?.name === "AbortError") {
      // Normal long-poll timeout — no updates arrived in 30s, just loop.
      return;
    }
    g.__pollerLastError = String((e as Error)?.message || e);
    console.error("[poller] pollOnce error:", e);
    await sleep(2000);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Start the polling loop. Idempotent — safe to call many times.
 * Uses globalThis.__pollerStarted so HMR reloads don't spawn duplicate pollers.
 */
export async function ensurePollerRunning(): Promise<PollerStatus> {
  if (g.__pollerStarted) {
    // Already started (even before an HMR reload) — don't start again!
    return getPollerStatus();
  }
  g.__pollerStarted = true;
  g.__pollerStartedAt = Date.now();
  g.__pollerIsLooping = true;

  console.log("[poller] Starting in-process Telegram long-poller (HMR-safe singleton)");
  console.log(`[poller] Bot token suffix: ...${TELEGRAM_BOT_TOKEN.slice(-6)}`);
  console.log(`[poller] Forwarding updates to: ${WEBHOOK_URL}`);

  // === AUTO-RESTORE SAFETY NET ===
  try {
    const restoredFrom = await autoRestoreIfEmpty();
    if (restoredFrom) {
      console.log(`[poller] ✅ DB auto-restored from backup: ${restoredFrom}`);
    } else {
      console.log("[poller] DB looks healthy — no auto-restore needed.");
    }
  } catch (e) {
    console.error("[poller] Auto-restore check failed:", e);
  }

  // Make sure no external webhook is set (would block getUpdates)
  try {
    const r = await tgCall("deleteWebhook", { drop_pending_updates: false });
    console.log("[poller] deleteWebhook result:", r);
  } catch (e) {
    console.error("[poller] deleteWebhook failed:", e);
  }

  // Infinite loop — runs in the background, never awaited by callers.
  // Only ONE loop ever runs because g.__pollerStarted is true on globalThis.
  void (async () => {
    while (g.__pollerIsLooping) {
      try {
        await pollOnce();
      } catch (e) {
        console.error("[poller] top-level poll error:", e);
        await sleep(2000);
      }
    }
  })();

  return getPollerStatus();
}
