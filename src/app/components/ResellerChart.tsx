"use client";

import { motion } from "framer-motion";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { TodaySummary, formatPKR } from "@/lib/types";

// Palette: amber → lime → sage (all readable on dark cards)
const COLORS = ["#F4C95D", "#F0FFB0", "#C9E66B", "#8FAE5C", "#6B8E5A"];

type Props = {
  summary: TodaySummary | null;
  subtitle?: string;
};

export function ResellerChart({ summary, subtitle }: Props) {
  const data = (summary?.breakdown ?? []).map((b) => ({
    name: b.reseller,
    units: b.units,
    revenue: b.revenue,
    profit: b.profit,
  }));

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.2 }}
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
            Sales by Reseller
          </h2>
          <p className="text-xs" style={{ color: "#C9E66B" }}>
            {subtitle ?? "Today · units sold per reseller"}
          </p>
        </div>
        <div
          className="rounded-lg px-3 py-1.5 text-xs font-semibold"
          style={{
            background: "rgba(244, 201, 93, 0.15)",
            color: "#F4C95D",
            border: "1px solid rgba(244, 201, 93, 0.3)",
          }}
        >
          {data.length} resellers
        </div>
      </div>

      {data.length === 0 ? (
        <div
          className="flex items-center justify-center h-64 rounded-xl text-sm font-medium"
          style={{
            background: "rgba(228, 253, 151, 0.06)",
            color: "#C9E66B",
            border: "1px dashed rgba(228, 253, 151, 0.2)",
          }}
        >
          No sales in this range.
        </div>
      ) : (
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
              <defs>
                {COLORS.map((c, i) => (
                  <linearGradient key={i} id={`barGrad${i}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={c} stopOpacity={1} />
                    <stop offset="100%" stopColor={c} stopOpacity={0.55} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(240, 255, 176, 0.1)" />
              <XAxis
                dataKey="name"
                tick={{ fill: "#C9E66B", fontSize: 12, fontWeight: 600 }}
                axisLine={{ stroke: "rgba(240, 255, 176, 0.2)" }}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: "#C9E66B", fontSize: 12, fontWeight: 600 }}
                axisLine={{ stroke: "rgba(240, 255, 176, 0.2)" }}
                tickLine={false}
                allowDecimals={false}
                width={40}
              />
              <Tooltip
                cursor={{ fill: "rgba(240, 255, 176, 0.08)" }}
                contentStyle={{
                  background: "#15211A",
                  border: "1px solid #4A6B47",
                  borderRadius: "12px",
                  color: "#F0FFB0",
                  fontSize: "13px",
                  boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                }}
                labelStyle={{ color: "#F4C95D", fontWeight: 700 }}
                formatter={(v: number, name: string) => {
                  if (name === "units") return [`${v} units`, "Units"];
                  return [formatPKR(v), name];
                }}
              />
              <Bar dataKey="units" radius={[8, 8, 0, 0]} animationDuration={800}>
                {data.map((_, i) => (
                  <Cell key={i} fill={`url(#barGrad${i % COLORS.length})`} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </motion.div>
  );
}
