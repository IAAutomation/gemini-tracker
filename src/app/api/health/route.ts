import { NextResponse } from "next/server";
import { getPollerStatus } from "@/lib/poller";
import { checkDbIntegrity, listBackups } from "@/lib/backup";
import { db } from "@/lib/db";

/**
 * GET /api/health
 *
 * Lightweight health-check endpoint. Returns server + poller + DB + backup
 * status so the dashboard can show a "Server Status" indicator.
 */
export async function GET() {
  const poller = getPollerStatus();
  const dbCheck = await checkDbIntegrity();
  const backups = await listBackups();

  let saleCount = 0;
  try {
    saleCount = await db.sale.count();
  } catch {
    saleCount = -1; // DB error
  }

  return NextResponse.json({
    success: true,
    timestamp: new Date().toISOString(),
    uptime_sec: Math.round(process.uptime()),
    poller,
    database: {
      ok: dbCheck.ok,
      size_bytes: dbCheck.size,
      error: dbCheck.error,
      sale_count: saleCount,
    },
    backups: {
      total: backups.length,
      latest: backups[0]?.name ?? null,
      latest_at: backups[0]?.mtime ?? null,
    },
  });
}
