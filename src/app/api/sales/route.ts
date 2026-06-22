import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { COST_PER_UNIT } from "@/lib/telegram";
import { backupAfterSale, backupAfterEdit } from "@/lib/backup";
import {
  endOfMonthPkt,
  endOfTodayPkt,
  endOfYearPkt,
  startOfMonthPkt,
  startOfRollingWeekPkt,
  startOfTodayPkt,
  startOfYearPkt,
} from "@/lib/pkt";

/**
 * GET /api/sales?range=today|week|month|year|all&limit=50
 *
 * Returns recent sales for the given range. Falls back to ?days=30 if no range.
 */
export async function GET(req: NextRequest) {
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? "100");
  const range = req.nextUrl.searchParams.get("range") as
    | "today"
    | "week"
    | "month"
    | "year"
    | "all"
    | null;
  const days = Number(req.nextUrl.searchParams.get("days") ?? "30");

  let where: { date?: { gte: Date; lt?: Date } } = {};

  if (range) {
    let start: Date;
    let end: Date | undefined;
    switch (range) {
      case "today":
        start = startOfTodayPkt();
        end = endOfTodayPkt();
        where = { date: { gte: start, lt: end } };
        break;
      case "week":
        start = startOfRollingWeekPkt();
        where = { date: { gte: start } };
        break;
      case "month":
        start = startOfMonthPkt();
        end = endOfMonthPkt();
        where = { date: { gte: start, lt: end } };
        break;
      case "year":
        start = startOfYearPkt();
        end = endOfYearPkt();
        where = { date: { gte: start, lt: end } };
        break;
      case "all":
      default:
        // No filter — return everything
        where = {};
        break;
    }
  } else {
    const since = new Date();
    since.setDate(since.getDate() - days);
    where = { date: { gte: since } };
  }

  const sales = await db.sale.findMany({
    where,
    orderBy: { date: "desc" },
    take: limit,
  });

  return NextResponse.json({ success: true, data: sales, total: sales.length });
}

/**
 * DELETE /api/sales
 * Wipes ALL sales from the database. Used by the dashboard's "Reset" button
 * to start over from zero.
 */
export async function DELETE() {
  // Snapshot BEFORE wiping (so the user can /restore if they regret it)
  void backupAfterEdit();
  const result = await db.sale.deleteMany({});
  // Also snapshot AFTER wiping (so we have the "empty" state too)
  void backupAfterEdit();
  return NextResponse.json({
    success: true,
    deleted: result.count,
    message: `All ${result.count} sales wiped. Database is now empty. Use /restore in Telegram to undo.`,
  });
}

/**
 * POST /api/sales
 * Body: { reseller_name, quantity, price_per_unit }
 * Auto-calculates revenue and profit and saves to DB.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const resellerName = String(body.reseller_name ?? body.resellerName ?? "").trim();
    const quantity = Number(body.quantity);
    const pricePerUnit = Number(body.price_per_unit ?? body.pricePerUnit);

    if (resellerName.length < 2) {
      return NextResponse.json(
        { success: false, error: "reseller_name must be at least 2 characters" },
        { status: 400 }
      );
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return NextResponse.json(
        { success: false, error: "quantity must be a positive integer" },
        { status: 400 }
      );
    }
    if (!Number.isInteger(pricePerUnit) || pricePerUnit <= 0) {
      return NextResponse.json(
        { success: false, error: "price_per_unit must be a positive integer (PKR)" },
        { status: 400 }
      );
    }
    if (pricePerUnit > 1000000) {
      return NextResponse.json(
        { success: false, error: "price_per_unit too large (max 1,000,000 PKR)" },
        { status: 400 }
      );
    }

    const revenue = quantity * pricePerUnit;
    const profit = (pricePerUnit - COST_PER_UNIT) * quantity;

    const sale = await db.sale.create({
      data: {
        resellerName,
        quantity,
        pricePerUnit,
        revenue,
        profit,
      },
    });

    // Auto-backup after every sale is added (via API)
    void backupAfterSale();
    void backupAfterEdit();

    return NextResponse.json({
      success: true,
      data: sale,
      message: "Sale saved successfully",
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
