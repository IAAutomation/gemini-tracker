import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  formatPktDate,
  pktDateKey,
  pktHour,
  pktMonthKey,
  pktParts,
  pktYear,
  startOfRollingWeekPkt,
  startOfMonthPkt,
  startOfTodayPkt,
  startOfYearPkt,
} from "@/lib/pkt";

/**
 * GET /api/sales/trend?range=today|week|month|year|all
 *
 * Returns aggregated per-bucket data, with buckets aligned to PKT:
 *   - today: 24 hourly buckets (00:00 PKT → 23:00 PKT)
 *   - week:  7 daily buckets (last 7 PKT days)
 *   - month: daily buckets for the current PKT month
 *   - year:  12 monthly buckets for the current PKT year
 *   - all:   yearly buckets (all-time, grouped by PKT year)
 */
export async function GET(req: NextRequest) {
  const range = (req.nextUrl.searchParams.get("range") ?? "week") as
    | "today"
    | "week"
    | "month"
    | "year"
    | "all";

  let start: Date;
  let bucketType: "hour" | "day" | "month" | "year";

  switch (range) {
    case "today": {
      start = startOfTodayPkt();
      bucketType = "hour";
      break;
    }
    case "week": {
      start = startOfRollingWeekPkt();
      bucketType = "day";
      break;
    }
    case "month": {
      start = startOfMonthPkt();
      bucketType = "day";
      break;
    }
    case "year": {
      start = startOfYearPkt();
      bucketType = "month";
      break;
    }
    case "all":
    default: {
      start = new Date(0); // epoch
      bucketType = "year";
      break;
    }
  }

  const sales = await db.sale.findMany({
    where: { date: { gte: start } },
  });

  // Bucket the sales using PKT-aware keys
  const buckets = new Map<string, { units: number; revenue: number; profit: number }>();

  for (const s of sales) {
    let key: string;
    switch (bucketType) {
      case "hour": {
        // "YYYY-MM-DD HH:00" in PKT
        key = `${pktDateKey(s.date)} ${String(pktHour(s.date)).padStart(2, "0")}:00`;
        break;
      }
      case "day": {
        key = pktDateKey(s.date); // YYYY-MM-DD in PKT
        break;
      }
      case "month": {
        key = pktMonthKey(s.date); // YYYY-MM in PKT
        break;
      }
      case "year": {
        key = String(pktYear(s.date));
        break;
      }
    }
    const cur = buckets.get(key) ?? { units: 0, revenue: 0, profit: 0 };
    cur.units += s.quantity;
    cur.revenue += s.revenue;
    cur.profit += s.profit;
    buckets.set(key, cur);
  }

  // Build the final array, filling in empty buckets for the range
  const data: { date: string; label: string; units: number; revenue: number; profit: number }[] = [];

  if (bucketType === "hour") {
    // Today's 24 hours (PKT) — start from startOfTodayPkt and increment by 1 hour
    const todayStart = startOfTodayPkt();
    for (let h = 0; h < 24; h++) {
      const bucketDate = new Date(todayStart.getTime() + h * 60 * 60 * 1000);
      const key = `${pktDateKey(bucketDate)} ${String(pktHour(bucketDate)).padStart(2, "0")}:00`;
      const v = buckets.get(key) ?? { units: 0, revenue: 0, profit: 0 };
      const label = `${String(h).padStart(2, "0")}:00`;
      data.push({ date: key, label, ...v });
    }
  } else if (bucketType === "day") {
    // Daily buckets — start from `start` (PKT midnight) and go to today
    const now = new Date();
    const cursor = new Date(start);
    while (cursor <= now) {
      const key = pktDateKey(cursor);
      const v = buckets.get(key) ?? { units: 0, revenue: 0, profit: 0 };
      const label = formatPktDate(cursor);
      data.push({ date: key, label, ...v });
      cursor.setDate(cursor.getDate() + 1);
    }
  } else if (bucketType === "month") {
    // 12 months of current PKT year
    const y = pktParts().year;
    for (let m = 0; m < 12; m++) {
      const key = `${y}-${String(m + 1).padStart(2, "0")}`;
      const v = buckets.get(key) ?? { units: 0, revenue: 0, profit: 0 };
      const label = new Date(Date.UTC(y, m, 1)).toLocaleDateString("en-US", {
        timeZone: "Asia/Karachi",
        month: "short",
      });
      data.push({ date: key, label, ...v });
    }
  } else if (bucketType === "year") {
    // All years that have sales, sorted
    const years = Array.from(buckets.keys()).sort();
    for (const y of years) {
      const v = buckets.get(y)!;
      data.push({ date: y, label: y, ...v });
    }
  }

  return NextResponse.json({ success: true, data });
}
