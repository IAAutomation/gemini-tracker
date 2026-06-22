"use client";

import { motion } from "framer-motion";
import { Package, DollarSign, TrendingUp, Users } from "lucide-react";
import { TodaySummary, formatPKR } from "@/lib/types";

type Props = {
  summary: TodaySummary | null;
};

export function SalesOverview({ summary }: Props) {
  const cards = [
    {
      label: "Total Units",
      value: (summary?.total_units ?? 0).toLocaleString("en-PK"),
      sub: summary?.top_reseller
        ? `Top: ${summary.top_reseller.name} (${summary.top_reseller.units})`
        : "No sales yet",
      icon: Package,
      gradient: "linear-gradient(135deg, #15211A 0%, #2D3E2C 100%)",
      color: "#F0FFB0",
      subColor: "#C9E66B",
      iconBg: "rgba(240, 255, 176, 0.18)",
      iconColor: "#F0FFB0",
      accentBorder: "#4A6B47",
    },
    {
      label: "Revenue",
      value: formatPKR(summary?.total_revenue ?? 0),
      sub: `Avg ${formatPKR(summary?.avg_price ?? 0)}/unit`,
      icon: DollarSign,
      gradient: "linear-gradient(135deg, #2D3E2C 0%, #4A6B47 100%)",
      color: "#F0FFB0",
      subColor: "#C9E66B",
      iconBg: "rgba(244, 201, 93, 0.2)",
      iconColor: "#F4C95D",
      accentBorder: "#6B8E5A",
    },
    {
      label: "Profit",
      value: formatPKR(summary?.total_profit ?? 0),
      sub: `After 250 PKR/unit cost`,
      icon: TrendingUp,
      gradient: "linear-gradient(135deg, #4A6B47 0%, #6B8E5A 100%)",
      color: "#F0FFB0",
      subColor: "#E4FD97",
      iconBg: "rgba(240, 255, 176, 0.25)",
      iconColor: "#F0FFB0",
      accentBorder: "#8FAE5C",
    },
    {
      label: "Resellers",
      value: String(summary?.breakdown?.length ?? 0),
      sub:
        summary && summary.breakdown && summary.breakdown.length > 0
          ? `${summary.breakdown.reduce((a, b) => a + (b.sales ?? 0), 0)} total sales`
          : "No sales yet",
      icon: Users,
      gradient: "linear-gradient(135deg, #6B8E5A 0%, #8FAE5C 100%)",
      color: "#15211A",
      subColor: "#2D3E2C",
      iconBg: "rgba(31, 46, 30, 0.18)",
      iconColor: "#1F2E1E",
      accentBorder: "#C9E66B",
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((c, i) => {
        const Icon = c.icon;
        return (
          <motion.div
            key={c.label}
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.05 + i * 0.06 }}
            whileHover={{ y: -4, scale: 1.02 }}
            className="rounded-2xl p-5 shadow-lg relative overflow-hidden"
            style={{
              background: c.gradient,
              color: c.color,
              border: `1px solid ${c.accentBorder}`,
            }}
          >
            {/* Subtle shine overlay */}
            <div
              className="absolute inset-0 opacity-30 pointer-events-none"
              style={{
                background:
                  "linear-gradient(135deg, rgba(255,255,255,0.08) 0%, transparent 50%)",
              }}
            />
            <div className="relative z-10 flex items-center justify-between mb-3">
              <span
                className="text-xs font-bold uppercase tracking-wider"
                style={{ color: c.subColor }}
              >
                {c.label}
              </span>
              <div
                className="flex h-9 w-9 items-center justify-center rounded-xl shadow-sm"
                style={{
                  background: c.iconBg,
                  color: c.iconColor,
                }}
              >
                <Icon className="h-4 w-4" />
              </div>
            </div>
            <div
              className="text-2xl md:text-3xl font-black tracking-tight mb-1.5"
              style={{ color: c.color }}
            >
              {c.value}
            </div>
            <div
              className="text-xs font-medium"
              style={{ color: c.subColor }}
            >
              {c.sub}
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
