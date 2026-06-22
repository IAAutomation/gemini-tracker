/**
 * Poller — disabled on Vercel (webhook mode is used instead).
 * These are no-op stubs so imports don't break.
 */

const isVercel = process.env.DATABASE_URL?.startsWith("postgresql") ?? false;

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
    started: false,
    isLooping: false,
    lastUpdateId: 0,
    pollCount: 0,
    lastPollAt: null,
    lastError: null,
    startedAt: null,
    uptimeSec: null,
  };
}

export async function ensurePollerRunning(): Promise<PollerStatus> {
  // No-op on Vercel — webhook mode is used
  return getPollerStatus();
}
