"use client";

import { motion } from "framer-motion";
import { Crown, Medal, Trophy } from "lucide-react";
import type { Sale } from "@/lib/types";
import { formatPKR } from "@/lib/types";

type Props = {
  sales: Sale[];
};

const MEDAL_COLORS = ["#F4C95D", "#C9E66B", "#8FAE5C"]; // amber, lime, sage

export function TopResellers({ sales }: Props) {
  // Aggregate by reseller
  const byReseller = new Map<
    string,
    { units: number; revenue: number; profit: number; sales: number }
  >();
  for (const s of sales) {
    const cur = byReseller.get(s.resellerName) ?? {
      units: 0,
      revenue: 0,
      profit: 0,
      sales: 0,
    };
    cur.units += s.quantity;
    cur.revenue += s.revenue;
    cur.profit += s.profit;
    cur.sales += 1;
    byReseller.set(s.resellerName, cur);
  }

  const sorted = Array.from(byReseller.entries())
    .sort((a, b) => b[1].units - a[1].units)
    .slice(0, 5);

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.34 }}
      className="rounded-2xl p-6 shadow-lg h-full relative overflow-hidden"
      style={{
        background: "linear-gradient(135deg, #15211A 0%, #1F2E1E 100%)",
        color: "#F0FFB0",
        border: "1px solid #4A6B47",
      }}
    >
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-bold" style={{ color: "#F0FFB0" }}>
            Top Resellers
          </h2>
          <p className="text-xs" style={{ color: "#C9E66B" }}>
            By units sold (selected range)
          </p>
        </div>
        <div
          className="flex h-9 w-9 items-center justify-center rounded-xl shadow-sm"
          style={{
            background: "linear-gradient(135deg, #F4C95D 0%, #D9A441 100%)",
            color: "#15211A",
          }}
        >
          <Trophy className="h-5 w-5" />
        </div>
      </div>

      {sorted.length === 0 ? (
        <div
          className="flex items-center justify-center h-48 rounded-xl text-sm font-medium"
          style={{
            background: "rgba(228, 253, 151, 0.06)",
            color: "#C9E66B",
            border: "1px dashed rgba(228, 253, 151, 0.2)",
          }}
        >
          No sales in this range.
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map(([name, v], i) => {
            const icon =
              i === 0 ? <Crown className="h-4 w-4" /> :
              i === 1 ? <Medal className="h-4 w-4" /> :
              i === 2 ? <Medal className="h-4 w-4" /> :
              null;
            const color = MEDAL_COLORS[i] || "#C9E66B";
            const maxUnits = sorted[0][1].units;
            const pct = Math.max(8, Math.round((v.units / maxUnits) * 100));
            return (
              <motion.div
                key={name}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.1 + i * 0.06 }}
                className="rounded-xl p-3"
                style={{
                  background: i === 0 ? "rgba(244, 201, 93, 0.15)" : "rgba(228, 253, 151, 0.04)",
                  border: i === 0
                    ? "1px solid rgba(244, 201, 93, 0.35)"
                    : "1px solid rgba(228, 253, 151, 0.08)",
                }}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <span
                      className="flex h-6 w-6 items-center justify-center rounded-full text-xs font-black"
                      style={{
                        background: color,
                        color: "#15211A",
                      }}
                    >
                      {i + 1}
                    </span>
                    <span className="font-bold" style={{ color: "#F0FFB0" }}>
                      {name}
                    </span>
                    {icon}
                  </div>
                  <span className="text-xs font-semibold" style={{ color: "#C9E66B" }}>
                    {v.units} units
                  </span>
                </div>
                <div
                  className="h-2 rounded-full overflow-hidden"
                  style={{ background: "rgba(228, 253, 151, 0.08)" }}
                >
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${pct}%` }}
                    transition={{ duration: 0.8, delay: 0.2 + i * 0.06 }}
                    className="h-full rounded-full"
                    style={{
                      background: `linear-gradient(90deg, ${color} 0%, #F0FFB0 100%)`,
                    }}
                  />
                </div>
                <div className="flex justify-between mt-1.5 text-xs font-medium" style={{ color: "#C9E66B" }}>
                  <span>{v.sales} sales · {formatPKR(v.revenue)} rev</span>
                  <span style={{ color: "#F4C95D" }}>{formatPKR(v.profit)} profit</span>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}
    </motion.div>
  );
}
