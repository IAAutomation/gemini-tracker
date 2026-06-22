"use client";

import { motion } from "framer-motion";
import { Activity, CheckCircle2, Database, MessageCircle, RotateCcw, Shield } from "lucide-react";
import { useEffect, useState } from "react";

type HealthInfo = {
  uptime_sec?: number;
  poller?: { started: boolean; isLooping: boolean; lastUpdateId: number; uptimeSec: number | null };
  database?: { ok: boolean; sale_count: number };
  backups?: { total: number; latest: string | null };
};

type Props = {
  botUsername?: string;
  onDataReset?: () => void;
};

export function BotPanel({ botUsername, onDataReset }: Props) {
  const [setupStatus, setSetupStatus] = useState<string>("");
  const [loading, setLoading] = useState<string>("");
  const [health, setHealth] = useState<HealthInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const data = await res.json();
        if (!cancelled) setHealth(data);
      } catch {
        if (!cancelled) setHealth(null);
      }
    };
    tick();
    const id = setInterval(tick, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  async function setupWebhook() {
    setLoading("setup");
    setSetupStatus("");
    try {
      const res = await fetch(`/api/telegram/setup?activate=true`);
      const data = await res.json();
      if (data.success) {
        setSetupStatus(
          `✅ Bot is live (long-polling mode)! Open @${data.bot?.username ?? "?"} in Telegram — replies arrive within 1-2 seconds.`
        );
      } else {
        setSetupStatus(`❌ Failed: ${data.error ?? "unknown error"}`);
      }
    } catch (e) {
      setSetupStatus(`❌ Error: ${(e as Error).message}`);
    } finally {
      setLoading("");
    }
  }

  async function resetData() {
    if (!confirm("Wipe ALL sales data? This cannot be undone.")) return;
    setLoading("reset");
    setSetupStatus("");
    try {
      const res = await fetch(`/api/sales`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        setSetupStatus(`✅ Reset complete. ${data.deleted} sales wiped — starting from zero.`);
        onDataReset?.();
      } else {
        setSetupStatus(`❌ Failed: ${data.error ?? "unknown error"}`);
      }
    } catch (e) {
      setSetupStatus(`❌ Error: ${(e as Error).message}`);
    } finally {
      setLoading("");
    }
  }

  const isLive = Boolean(botUsername);
  const pollerAlive = health?.poller?.isLooping ?? false;
  const dbOk = health?.database?.ok ?? false;
  const saleCount = health?.database?.sale_count ?? 0;
  const backupCount = health?.backups?.total ?? 0;
  const serverUp = health !== null;

  function fmtUptime(s?: number) {
    if (!s) return "—";
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.16 }}
      className="rounded-2xl p-6 shadow-lg relative overflow-hidden"
      style={{
        background: "linear-gradient(135deg, #15211A 0%, #2D3E2C 60%, #4A6B47 100%)",
        color: "#F0FFB0",
        border: "1px solid #6B8E5A",
      }}
    >
      {/* Decorative orb */}
      <div
        className="absolute -top-8 -right-8 w-32 h-32 rounded-full opacity-20 blur-2xl pointer-events-none"
        style={{ background: "radial-gradient(circle, #F4C95D 0%, transparent 70%)" }}
      />

      <div className="relative z-10 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div
            className="flex h-11 w-11 items-center justify-center rounded-xl shadow-md"
            style={{
              background: "linear-gradient(135deg, #F4C95D 0%, #D9A441 100%)",
              color: "#15211A",
            }}
          >
            <MessageCircle className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold" style={{ color: "#F0FFB0" }}>
              Telegram Bot
            </h2>
            <p className="text-xs flex items-center gap-1.5 font-medium" style={{ color: "#C9E66B" }}>
              {isLive ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5" style={{ color: "#F4C95D" }} />
                  @{botUsername} · live
                </>
              ) : (
                "Activate to start using the bot"
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={resetData}
            disabled={loading !== ""}
            className="rounded-xl px-4 py-2.5 text-sm font-bold transition-all hover:scale-105 disabled:opacity-50 flex items-center gap-2"
            style={{
              background: "rgba(201, 83, 74, 0.2)",
              color: "#FFB8AE",
              border: "1px solid rgba(201, 83, 74, 0.4)",
            }}
            title="Wipe all sales data and start fresh"
          >
            <RotateCcw className="h-4 w-4" />
            {loading === "reset" ? "Resetting..." : "Reset Data"}
          </button>
          <button
            onClick={setupWebhook}
            disabled={loading !== ""}
            className="rounded-xl px-5 py-2.5 text-sm font-bold transition-all hover:scale-105 disabled:opacity-50"
            style={{
              background: "linear-gradient(135deg, #F4C95D 0%, #D9A441 100%)",
              color: "#15211A",
              border: "1px solid #D9A441",
              boxShadow: "0 2px 8px rgba(244, 201, 93, 0.3)",
            }}
          >
            {loading === "setup" ? "Working..." : isLive ? "Re-activate" : "Activate Bot"}
          </button>
        </div>
      </div>

      {/* System health row */}
      <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2 relative z-10">
        <StatusChip
          icon={<Activity className="h-3.5 w-3.5" />}
          label="Server"
          value={serverUp ? `up · ${fmtUptime(health?.uptime_sec)}` : "down"}
          ok={serverUp}
        />
        <StatusChip
          icon={<MessageCircle className="h-3.5 w-3.5" />}
          label="Poller"
          value={pollerAlive ? "looping" : "stopped"}
          ok={pollerAlive}
        />
        <StatusChip
          icon={<Database className="h-3.5 w-3.5" />}
          label="Database"
          value={dbOk ? `${saleCount} sales` : "error"}
          ok={dbOk}
        />
        <StatusChip
          icon={<Shield className="h-3.5 w-3.5" />}
          label="Backups"
          value={`${backupCount} snapshots`}
          ok={backupCount > 0}
        />
      </div>

      {setupStatus && (
        <div
          className="mt-3 rounded-xl px-4 py-2 text-xs font-medium relative z-10"
          style={{
            background: "rgba(244, 201, 93, 0.12)",
            color: "#F4C95D",
            border: "1px solid rgba(244, 201, 93, 0.3)",
          }}
        >
          {setupStatus}
        </div>
      )}
    </motion.div>
  );
}

function StatusChip({
  icon,
  label,
  value,
  ok,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  ok: boolean;
}) {
  return (
    <div
      className="rounded-xl px-3 py-2 flex items-center gap-2"
      style={{
        background: ok
          ? "rgba(244, 201, 93, 0.12)"
          : "rgba(201, 83, 74, 0.18)",
        border: ok
          ? "1px solid rgba(244, 201, 93, 0.3)"
          : "1px solid rgba(201, 83, 74, 0.4)",
      }}
    >
      <span style={{ color: ok ? "#F4C95D" : "#FFB8AE" }}>{icon}</span>
      <div className="flex flex-col min-w-0">
        <span
          className="text-[10px] uppercase tracking-wider font-bold"
          style={{ color: ok ? "#C9E66B" : "#FFB8AE" }}
        >
          {label}
        </span>
        <span
          className="text-xs font-bold truncate"
          style={{ color: ok ? "#F0FFB0" : "#FFB8AE" }}
        >
          {value}
        </span>
      </div>
    </div>
  );
}
