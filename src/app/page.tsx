"use client";

import { useCallback, useEffect, useState } from "react";
import { Header } from "./components/Header";
import { SalesOverview } from "./components/SalesOverview";
import { ResellerChart } from "./components/ResellerChart";
import { TrendChart } from "./components/TrendChart";
import { SalesTable } from "./components/SalesTable";
import { BotPanel } from "./components/BotPanel";
import { PaymentBreakdown } from "./components/PaymentBreakdown";
import { TopResellers } from "./components/TopResellers";
import { TimeRangeSelector } from "./components/TimeRangeSelector";
import type { Range, Sale, TodaySummary, TrendPoint } from "@/lib/types";

const POLL_MS = 4000; // 4-second real-time polling

const RANGE_LABELS: Record<Range, { trendTitle: string; trendSubtitle: string; chartSubtitle: string }> = {
  today: {
    trendTitle: "Today's Hourly Trend",
    trendSubtitle: "Profit per hour, today",
    chartSubtitle: "Today · units sold per reseller",
  },
  week: {
    trendTitle: "7-Day Profit Trend",
    trendSubtitle: "Profit per day, last 7 days",
    chartSubtitle: "Last 7 days · units per reseller",
  },
  month: {
    trendTitle: "This Month's Daily Trend",
    trendSubtitle: "Profit per day, current month",
    chartSubtitle: "This month · units per reseller",
  },
  year: {
    trendTitle: "This Year's Monthly Trend",
    trendSubtitle: "Profit per month, current year",
    chartSubtitle: "This year · units per reseller",
  },
  all: {
    trendTitle: "All-Time Yearly Trend",
    trendSubtitle: "Profit per year, all-time",
    chartSubtitle: "All-time · units per reseller",
  },
};

export default function Home() {
  const [range, setRange] = useState<Range>("today");
  const [summary, setSummary] = useState<TodaySummary | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [botUsername, setBotUsername] = useState<string | undefined>(undefined);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      try {
        const [sumRes, trendRes, salesRes, setupRes] = await Promise.all([
          fetch(`/api/sales/today?range=${range}`, { cache: "no-store" }),
          fetch(`/api/sales/trend?range=${range}`, { cache: "no-store" }),
          fetch(`/api/sales?range=${range}&limit=50`, { cache: "no-store" }),
          fetch("/api/telegram/setup", { cache: "no-store" }),
        ]);

        const sumJson = await sumRes.json();
        const trendJson = await trendRes.json();
        const salesJson = await salesRes.json();
        const setupJson = await setupRes.json();

        if (cancelled) return;
        if (sumJson.success) setSummary(sumJson.data);
        if (trendJson.success) setTrend(trendJson.data);
        if (salesJson.success) setSales(salesJson.data);
        if (setupJson.success) setBotUsername(setupJson.bot?.username);
      } catch (e) {
        console.error("Load error:", e);
      }
    };

    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [range, refreshKey]);

  // Force an immediate re-fetch (used by the "Reset Data" button).
  const handleDataReset = useCallback(() => {
    setSummary(null);
    setTrend([]);
    setSales([]);
    setRefreshKey((k) => k + 1);
  }, []);

  const today = new Date().toISOString().slice(0, 10);
  const labels = RANGE_LABELS[range];

  return (
    <main className="relative z-10 min-h-screen p-4 md:p-8 max-w-7xl mx-auto">
      <div className="flex flex-col gap-6">
        <Header today={today} />

        <TimeRangeSelector value={range} onChange={setRange} />

        <SalesOverview summary={summary} />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <ResellerChart summary={summary} subtitle={labels.chartSubtitle} />
          <TrendChart trend={trend} title={labels.trendTitle} subtitle={labels.trendSubtitle} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <PaymentBreakdown sales={sales} />
          <TopResellers sales={sales} />
        </div>

        <SalesTable sales={sales} />

        {/* BotPanel moved to the bottom — server status, reset, re-activate controls */}
        <BotPanel botUsername={botUsername} onDataReset={handleDataReset} />

        <footer
          className="mt-2 mb-4 text-center text-xs"
          style={{ color: "#4A6B47" }}
        >
          Gemini Sales Tracker · Auto-refreshes every 4s · 14 bot commands ·
          Built with Next.js + Prisma (SQLite) · 100% free stack · Auto-backup on every sale
        </footer>
      </div>
    </main>
  );
}
