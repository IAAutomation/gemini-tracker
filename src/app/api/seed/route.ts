import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * POST /api/seed
 * Inserts sample sales for the last 7 days so the dashboard has data to show.
 */
export async function POST() {
  const resellers = [
    { name: "Ali", price: 400 },
    { name: "Omar", price: 500 },
    { name: "Karim", price: 600 },
    { name: "Suhail", price: 550 },
  ];

  const created: unknown[] = [];

  // 7 days of history, with 2–4 sales per day
  for (let dayOffset = 6; dayOffset >= 0; dayOffset--) {
    const date = new Date();
    date.setDate(date.getDate() - dayOffset);
    date.setHours(10 + dayOffset, 15 * dayOffset, 0, 0);

    const numSales = 2 + ((dayOffset * 3) % 3); // 2..4 sales
    for (let i = 0; i < numSales; i++) {
      const r = resellers[(dayOffset + i) % resellers.length];
      const qty = 2 + ((dayOffset + i * 2) % 4); // 2..5 units
      const revenue = qty * r.price;
      const profit = (r.price - 250) * qty;
      const sale = await db.sale.create({
        data: {
          resellerName: r.name,
          quantity: qty,
          pricePerUnit: r.price,
          revenue,
          profit,
          date: new Date(date.getTime() + i * 60 * 60 * 1000),
        },
      });
      created.push(sale);
    }
  }

  return NextResponse.json({ success: true, inserted: created.length });
}
