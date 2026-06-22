"use client";

import { motion } from "framer-motion";
import { Calendar, Clock, Globe2, TrendingUp, Zap } from "lucide-react";
import type { Range } from "@/lib/types";

type Props = {
  value: Range;
  onChange: (range: Range) => void;
};

const OPTIONS: { value: Range; label: string; icon: React.ElementType }[] = [
  { value: "today", label: "Today", icon: Zap },
  { value: "week", label: "7 Days", icon: Clock },
  { value: "month", label: "This Month", icon: Calendar },
  { value: "year", label: "This Year", icon: TrendingUp },
  { value: "all", label: "All Time", icon: Globe2 },
];

export function TimeRangeSelector({ value, onChange }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="rounded-2xl p-3 shadow-lg flex flex-wrap items-center gap-2 relative overflow-hidden"
      style={{
        background: "linear-gradient(135deg, #15211A 0%, #2D3E2C 100%)",
        border: "1px solid #4A6B47",
      }}
    >
      <span
        className="text-xs font-bold uppercase tracking-wider mr-2 hidden sm:inline pl-1"
        style={{ color: "#F4C95D" }}
      >
        📊 View:
      </span>
      {OPTIONS.map((opt) => {
        const Icon = opt.icon;
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className="rounded-xl px-3.5 py-2 text-sm font-bold transition-all hover:scale-105 flex items-center gap-1.5"
            style={{
              background: active
                ? "linear-gradient(135deg, #F4C95D 0%, #D9A441 100%)"
                : "rgba(228, 253, 151, 0.08)",
              color: active ? "#15211A" : "#F0FFB0",
              border: active
                ? "1px solid #D9A441"
                : "1px solid rgba(228, 253, 151, 0.15)",
              boxShadow: active
                ? "0 4px 12px rgba(244, 201, 93, 0.35)"
                : "none",
            }}
          >
            <Icon className="h-3.5 w-3.5" />
            {opt.label}
          </button>
        );
      })}
    </motion.div>
  );
}
