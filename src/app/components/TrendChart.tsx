"use client";

import { motion } from "framer-motion";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { TrendPoint, formatPKR } from "@/lib/types";

type Props = {
  trend: TrendPoint[];
  title?: string;
  subtitle?: string;
};

export function TrendChart({ trend, title, subtitle }: Props) {
  const data = trend.map((p) => ({
    label: p.label ?? p.date,
    units: p.units,
    revenue: p.revenue,
    profit: p.profit,
  }));

  const totalProfit = trend.reduce((s, p) => s + p.profit, 0);
  const peakProfit = trend.length > 0 ? Math.max(...trend.map((p) => p.profit)) : 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.28 }}
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
            {title ?? "Profit Trend"}
          </h2>
          <p className="text-xs" style={{ color: "#C9E66B" }}>
            {subtitle ?? "Profit over time"}
          </p>
        </div>
        <div
          className="rounded-lg px-3 py-1.5 text-xs font-semibold flex items-center gap-2"
          style={{
            background: "rgba(244, 201, 93, 0.15)",
            color: "#F4C95D",
            border: "1px solid rgba(244, 201, 93, 0.3)",
          }}
        >
          <span>{trend.length} pts</span>
          <span style={{ color: "#4A6B47" }}>·</span>
          <span>Σ {formatPKR(totalProfit)}</span>
          <span style={{ color: "#4A6B47" }}>·</span>
          <span>peak {formatPKR(peakProfit)}</span>
        </div>
      </div>

      {trend.length === 0 || totalProfit === 0 ? (
        <div
          className="flex items-center justify-center h-72 rounded-xl text-sm font-medium"
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
            <AreaChart data={data} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id="profitGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#F4C95D" stopOpacity={0.9} />
                  <stop offset="50%" stopColor="#C9E66B" stopOpacity={0.6} />
                  <stop offset="100%" stopColor="#C9E66B" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(240, 255, 176, 0.1)" />
              <XAxis
                dataKey="label"
                tick={{ fill: "#C9E66B", fontSize: 11, fontWeight: 600 }}
                axisLine={{ stroke: "rgba(240, 255, 176, 0.2)" }}
                tickLine={false}
                interval="preserveStartEnd"
                minTickGap={20}
              />
              <YAxis
                tick={{ fill: "#C9E66B", fontSize: 11, fontWeight: 600 }}
                axisLine={{ stroke: "rgba(240, 255, 176, 0.2)" }}
                tickLine={false}
                width={60}
              />
              <Tooltip
                cursor={{ stroke: "rgba(244, 201, 93, 0.5)", strokeWidth: 2 }}
                contentStyle={{
                  background: "#15211A",
                  border: "1px solid #4A6B47",
                  borderRadius: "12px",
                  color: "#F0FFB0",
                  fontSize: "13px",
                  boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                }}
                labelStyle={{ color: "#F4C95D", fontWeight: 700 }}
                formatter={(v: number) => [formatPKR(v), "Profit"]}
              />
              <Area
                type="monotone"
                dataKey="profit"
                stroke="#F4C95D"
                strokeWidth={2.5}
                fill="url(#profitGrad)"
                animationDuration={900}
                dot={{ fill: "#F4C95D", r: 3, strokeWidth: 0 }}
                activeDot={{ fill: "#F0FFB0", r: 5, stroke: "#F4C95D", strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </motion.div>
  );
}
