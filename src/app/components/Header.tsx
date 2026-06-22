"use client";

import { motion } from "framer-motion";
import { Sparkles, TrendingUp } from "lucide-react";

export function Header({ today }: { today: string }) {
  return (
    <motion.header
      initial={{ opacity: 0, y: -16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="rounded-3xl p-6 md:p-8 shadow-xl relative overflow-hidden"
      style={{
        background: "linear-gradient(135deg, #15211A 0%, #1F2E1E 40%, #2D3E2C 100%)",
        color: "#F0FFB0",
        border: "1px solid #4A6B47",
      }}
    >
      {/* Decorative gradient orbs */}
      <div
        className="absolute -top-12 -right-12 w-48 h-48 rounded-full opacity-30 blur-3xl"
        style={{ background: "radial-gradient(circle, #F4C95D 0%, transparent 70%)" }}
      />
      <div
        className="absolute -bottom-16 -left-16 w-56 h-56 rounded-full opacity-20 blur-3xl"
        style={{ background: "radial-gradient(circle, #C9E66B 0%, transparent 70%)" }}
      />

      <div className="relative z-10 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div className="flex items-center gap-4">
          <div
            className="flex h-16 w-16 items-center justify-center rounded-2xl shadow-lg"
            style={{
              background: "linear-gradient(135deg, #F0FFB0 0%, #C9E66B 100%)",
              color: "#1F2E1E",
              border: "2px solid #F4C95D",
            }}
          >
            <Sparkles className="h-8 w-8" />
          </div>
          <div>
            <h1
              className="text-2xl md:text-4xl font-black tracking-tight"
              style={{ color: "#F0FFB0" }}
            >
              Gemini Sales Tracker
            </h1>
            <p
              className="text-sm md:text-base flex items-center gap-1.5 mt-0.5"
              style={{ color: "#C9E66B" }}
            >
              <TrendingUp className="h-3.5 w-3.5" />
              Reseller Business Dashboard · Live
            </p>
          </div>
        </div>
        <div
          className="rounded-2xl px-5 py-3 text-sm font-semibold shadow-md"
          style={{
            background: "rgba(244, 201, 93, 0.18)",
            color: "#F4C95D",
            border: "1px solid rgba(244, 201, 93, 0.35)",
            backdropFilter: "blur(8px)",
          }}
        >
          {new Date(today).toLocaleDateString("en-US", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
          })}
        </div>
      </div>
    </motion.header>
  );
}
