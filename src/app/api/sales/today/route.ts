import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  endOfMonthPkt,
  endOfTodayPkt,
  endOfYearPkt,
  formatPktDate,
  formatPktFullDate,
  pktParts,
  startOfMonthPkt,
  startOfRollingWeekPkt,
  startOfTodayPkt,
  startOfYearPkt,
} from "@/lib/pkt";

/**
 * GET /api/sales/today?range=today|week|month|year|all
 *
 * Returns aggregated summary for the given range, all computed in PKT
 * (Peshawar / Asia-Karachi time, UTC+5):
 *   - today: midnight PKT today → midnight PKT tomorrow
 *   - week:  last 7 calendar days in PKT (rolling)
 *   - month: current PKT calendar month
 *   - year:  current PKT calendar year
 *   - all:   all-time (no date filter)
 */
export async function GET(req: NextRequest) {
  const range = (req.nextUrl.searchParams.get("range") ?? "today") as
    | "today"
    | "week"
    | "month"
    | "year"
    | "all";

  let start: Date;
  let end: Date;
  let dateLabel: string;

  switch (range) {
    case "today": {
      start = startOfTodayPkt();
      end = endOfTodayPkt();
      dateLabel = formatPktDate(start);
      break;
    }
    case "week": {
      start = startOfRollingWeekPkt();
      end = new Date(); // now
      dateLabel = `${formatPktDate(start)} → ${formatPktDate(end)}`;
      break;
    }
    case "month": {
      start = startOfMonthPkt();
      end = endOfMonthPkt();
      const p = pktParts();
      dateLabel = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Karachi",
        month: "long",
        year: "numeric",
      }).format(new Date());
      void p;
      break;
    }
    case "year": {
      start = startOfYearPkt();
      end = endOfYearPkt();
      dateLabel = String(pktParts().year);
      break;
    }
    case "all":
    default: {
      start = new Date(0); // epoch
      end = new Date(); // now
      dateLabel = "All-time";
      break;
    }
  }

  const sales = await db.sale.findMany({
    where: { date: { gte: start, lt: end } },
    orderBy: { date: "desc" },
  });

  const totalUnits = sales.reduce((s, x) => s + x.quantity, 0);
  const totalRevenue = sales.reduce((s, x) => s + x.revenue, 0);
  const totalProfit = sales.reduce((s, x) => s + x.profit, 0);
  const avgPrice = totalUnits === 0 ? 0 : Math.round(totalRevenue / totalUnits);

  // Group by reseller for breakdown + top reseller
  const byReseller = new Map<
    string,
    { units: number; revenue: number; profit: number; price: number; sales: number }
  >();
  for (const s of sales) {
    const cur = byReseller.get(s.resellerName) ?? {
      units: 0,
      revenue: 0,
      profit: 0,
      price: s.pricePerUnit,
      sales: 0,
    };
    cur.units += s.quantity;
    cur.revenue += s.revenue;
    cur.profit += s.profit;
    cur.sales += 1;
    byReseller.set(s.resellerName, cur);
  }

  const breakdown = Array.from(byReseller.entries())
    .map(([reseller, v]) => ({
      reseller,
      units: v.units,
      price: v.price,
      revenue: v.revenue,
      profit: v.profit,
      sales: v.sales,
    }))
    .sort((a, b) => b.units - a.units);

  const topReseller =
    breakdown.length > 0
      ? { name: breakdown[0].reseller, units: breakdown[0].units }
      : null;

  return NextResponse.json({
    success: true,
    data: {
      date: dateLabel,
      range,
      total_units: totalUnits,
      total_revenue: totalRevenue,
      total_profit: totalProfit,
      avg_price: avgPrice,
      top_reseller: topReseller,
      breakdown,
    },
  });
}
