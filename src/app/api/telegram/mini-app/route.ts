import { NextRequest, NextResponse } from "next/server";
import {
  TELEGRAM_API_BASE,
  TELEGRAM_BOT_TOKEN,
} from "@/lib/telegram";

/**
 * GET /api/telegram/mini-app
 *
 * Returns the Mini App configuration for the bot. Telegram Mini Apps require:
 *   1. A public HTTPS URL where the app is served
 *   2. The bot to have a "Menu Button" pointing to that URL (via setChatMenuButton)
 *   3. The web app itself to load Telegram's web_app.js script
 *
 * This endpoint:
 *   - Auto-detects the public URL from request headers (X-Forwarded-Host)
 *   - Falls back to a ?url= query param if provided
 *   - Sets the bot's chat menu button to open the dashboard
 *
 * Example: GET /api/telegram/mini-app?url=https://preview-abc.space-z.ai
 */
export async function GET(req: NextRequest) {
  const explicitUrl = req.nextUrl.searchParams.get("url");

  // Auto-detect from headers
  let publicOrigin: string | null = explicitUrl;
  if (!publicOrigin) {
    const proto =
      req.headers.get("x-forwarded-proto") || "https";
    const host =
      req.headers.get("x-forwarded-host") ||
      req.headers.get("host");
    if (host && !host.startsWith("localhost") && !host.startsWith("127.0.0.1")) {
      publicOrigin = `${proto}://${host}`;
    }
  }

  if (!publicOrigin) {
    return NextResponse.json({
      success: false,
      error: "Could not auto-detect public URL. Pass ?url=https://your-preview-url",
      hint: "Open the dashboard preview in your browser, copy the URL from the address bar, then call: /api/telegram/mini-app?url=<that-url>",
    }, { status: 400 });
  }

  const dashboardUrl = `${publicOrigin.replace(/\/+$/, "")}/`;

  // Set the chat menu button (the small ≡ button next to the text input)
  // to open the dashboard as a Mini App
  const menuButtonRes = await fetch(`${TELEGRAM_API_BASE}/setChatMenuButton`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      menu_button: {
        type: "web_app",
        text: "📊 Dashboard",
        web_app: { url: dashboardUrl },
      },
    }),
  });
  const menuButtonData = await menuButtonRes.json();

  return NextResponse.json({
    success: true,
    dashboard_url: dashboardUrl,
    menu_button: menuButtonData,
    instructions: [
      "✅ The chat menu button (≡ next to text input) now opens the dashboard.",
      "",
      "To open the Mini App manually:",
      `  1. Open @salessstrackerbot in Telegram`,
      `  2. Tap the ≡ button (left of the text input)`,
      `  3. The dashboard opens in Telegram's built-in browser`,
      "",
      "To share the Mini App link with others:",
      `  Send them this URL: ${dashboardUrl}`,
      "  (or use the /start attach parameter)",
    ].join("\n"),
  });
}
