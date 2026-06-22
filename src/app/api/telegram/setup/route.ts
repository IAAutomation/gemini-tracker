import { NextRequest, NextResponse } from "next/server";
import {
  TELEGRAM_API_BASE,
  TELEGRAM_BOT_TOKEN,
} from "@/lib/telegram";
import { ensurePollerRunning, getPollerStatus } from "@/lib/poller";

// Auto-start the in-process long-poller on first module load.
// POLLER DISABLED ON VERCEL

/**
 * GET /api/telegram/setup
 *
 * - With ?activate=true  → starts the in-process long-poller (recommended).
 *   No webhook registration needed — the poller calls Telegram directly.
 *
 * - With ?url=...        → (legacy) sets a Telegram webhook at the given URL.
 *   Use only if you have a public HTTPS URL Telegram can reach.
 *
 * - With neither         → returns current bot + poller + webhook status.
 */
export async function GET(req: NextRequest) {
  const explicitUrl = req.nextUrl.searchParams.get("url");
  const activate = req.nextUrl.searchParams.get("activate") === "true";

  if (!TELEGRAM_BOT_TOKEN) {
    return NextResponse.json(
      { success: false, error: "TELEGRAM_BOT_TOKEN not set" },
      { status: 500 }
    );
  }

  // Get bot info
  const meRes = await fetch(`${TELEGRAM_API_BASE}/getMe`);
  const me = await meRes.json();

  // ---- Activate: start the in-process poller ----
  if (activate) {
    try {
      // Poller disabled on Vercel — webhook mode
      // Also register the 24 commands with Telegram's command menu
      const commandsRes = await fetch(`${TELEGRAM_API_BASE}/setMyCommands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commands: [
            // Daily
            { command: "new", description: "Log a new sale (custom qty/price)" },
            { command: "daily", description: "Today's stats" },
            { command: "sale", description: "📅 Manage units (delete/edit/pay)" },
            { command: "saledit", description: "Alias for /sale (Units Manager)" },
            { command: "pay", description: "📅 Payment calendar (toggle)" },
            // Stats
            { command: "stats", description: "📅 Calendar — any month/day" },
            { command: "weekly", description: "Last 7 days summary" },
            { command: "month", description: "Current month stats" },
            { command: "compare", description: "Compare 2 periods" },
            { command: "revenue", description: "Cash flow: collected vs pending" },
            { command: "margins", description: "Profit margin by price" },
            { command: "milestone", description: "Business milestones" },
            // Resellers
            { command: "resellers", description: "All resellers (tap to view)" },
            { command: "top", description: "Top resellers leaderboard" },
            { command: "reseller", description: "One reseller's history" },
            { command: "pending", description: "All pending payments" },
            // Manage
            { command: "search", description: "Search sales (name/price/date)" },
            { command: "undo", description: "Delete your most recent sale" },
            { command: "export", description: "Download all sales as CSV" },
            { command: "report", description: "30-day CSV report" },
            // Configuration (owner/admin)
            { command: "settings", description: "⚙️ View & edit bot settings" },
            { command: "admin", description: "🔐 Admin panel (stats/wipe)" },
            // Data Safety
            { command: "backup", description: "Snapshot the database now" },
            { command: "restore", description: "Restore from latest backup" },
            { command: "help", description: "Show all commands" },
          ],
        }),
      });
      const commandsData = await commandsRes.json();

      // ---- Set up the Telegram Mini App (chat menu button) ----
      // Auto-detect public URL from request headers
      const proto = req.headers.get("x-forwarded-proto") || "https";
      const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
      let miniAppUrl: string | null = null;
      let menuButtonData: unknown = null;
      if (host && !host.startsWith("localhost") && !host.startsWith("127.0.0.1")) {
        miniAppUrl = `${proto}://${host}/`;
        const menuRes = await fetch(`${TELEGRAM_API_BASE}/setChatMenuButton`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            menu_button: {
              type: "web_app",
              text: "📊 Dashboard",
              web_app: { url: miniAppUrl },
            },
          }),
        });
        menuButtonData = await menuRes.json();
      }

      // Re-fetch webhook info to confirm we're in polling mode
      const infoRes = await fetch(`${TELEGRAM_API_BASE}/getWebhookInfo`);
      const info = await infoRes.json();

      return NextResponse.json({
        success: true,
        mode: "long-polling (in-process)",
        bot: me.result,
        setCommands: commandsData,
        webhook_info: info.result,
        poller: status,
        mini_app: miniAppUrl
          ? { url: miniAppUrl, menu_button_set: (menuButtonData as { ok?: boolean })?.ok === true }
          : { url: null, hint: "Open via the public preview URL to auto-configure the mini-app menu button." },
        instructions:
          "Poller started. Open @" +
          (me.result?.username ?? "?") +
          " in Telegram. Tap the ≡ button (left of the text input) to open the dashboard as a Mini App, or send /new, /daily, /stats, etc.",
      });
    } catch (e) {
      return NextResponse.json(
        { success: false, error: (e as Error).message },
        { status: 500 }
      );
    }
  }

  // ---- Legacy: explicit webhook URL ----
  if (explicitUrl) {
    const webhookUrl = `${explicitUrl.replace(/\/+$/, "")}/api/telegram/webhook`;
    const setRes = await fetch(`${TELEGRAM_API_BASE}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl, drop_pending_updates: true }),
    });
    const setData = await setRes.json();
    const infoRes = await fetch(`${TELEGRAM_API_BASE}/getWebhookInfo`);
    const info = await infoRes.json();
    return NextResponse.json({
      success: true,
      mode: "webhook",
      webhook_url: webhookUrl,
      setWebhook: setData,
      bot: me.result,
      webhook_info: info.result,
    });
  }

  // ---- Default: status only ----
  const infoRes = await fetch(`${TELEGRAM_API_BASE}/getWebhookInfo`);
  const info = await infoRes.json();
  return NextResponse.json({
    success: true,
    bot: me.result,
    webhook_info: info.result,
    poller: getPollerStatus(),
  });
}
