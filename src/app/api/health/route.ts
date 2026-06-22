import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  let saleCount = 0;
  let dbOk = true;
  let dbError: string | undefined;

  try {
    saleCount = await db.sale.count();
  } catch (e) {
    dbOk = false;
    dbError = (e as Error).message;
  }

  return NextResponse.json({
    success: true,
    timestamp: new Date().toISOString(),
    uptime_sec: Math.round(process.uptime()),
    database: {
      ok: dbOk,
      sale_count: saleCount,
      error: dbError,
    },
  });
}
