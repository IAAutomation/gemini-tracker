import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  ALLOWED_PRICES,
  COST_PER_UNIT,
  TELEGRAM_CHAT_ID,
  adminAuthedUsers,
  answerCallbackQuery,
  buildCalendarDayKeyboard,
  buildCalendarMonthKeyboard,
  buildCalendarYearKeyboard,
  buildMenuKeyboard,
  buildPayCalendarMonthKeyboard,
  buildPayCalendarYearKeyboard,
  buildPayDayKeyboard,
  buildPaymentKeyboard,
  buildSalesListKeyboard,
  buildSalesActionKeyboard,
  buildSalesCalendarMonthKeyboard,
  buildSalesCalendarYearKeyboard,
  buildSalesDayKeyboard,
  buildResellerAnalysisReport,
  buildResellerShareReport,
  calendarMonthText,
  calendarYearText,
  clearConversation,
  editMessageText,
  escapeHtml,
  formatPKR,
  formatPayment,
  getConversation,
  isOwnerOrAdminAuthed,
  menuText,
  payCalendarMonthText,
  payCalendarYearText,
  paymentListText,
  salesActionText,
  salesCalendarMonthText,
  salesCalendarYearText,
  salesDayText,
  sendMessage,
  setConversation,
  salesListText,
  type ConversationState,
  type PaymentStatus,
  type SaleRow,
} from "@/lib/telegram";
import {
  getSetting,
  setSetting,
  getTypedSettings,
  SETTING_DEFS,
} from "@/lib/settings";
import { ensurePollerRunning } from "@/lib/poller";
import { backupAfterEdit, backupAfterSale, listBackups, restoreFromLatestBackup } from "@/lib/backup";
import { promises as fs } from "fs";
import {
  daysInMonthPkt,
  endOfMonthPkt,
  endOfTodayPkt,
  endOfYearPkt,
  firstWeekdayOfMonthPkt,
  formatPktDate,
  formatPktDateTime,
  formatPktFullDate,
  formatPktTime,
  pktDateKey,
  pktMidnightUtc,
  pktMonthKey,
  pktParts,
  startOfMonthPkt,
  startOfRollingWeekPkt,
  startOfTodayPkt,
  startOfYearPkt,
} from "@/lib/pkt";

// Auto-start the in-process long-poller when this module first loads.
// This ensures the bot is always responsive without requiring the user to
// click "Activate" — the button is still useful to re-trigger if needed.
// POLLER DISABLED ON VERCEL — webhook mode is used instead

/**
 * POST /api/telegram/webhook
 *
 * Receives Telegram updates and drives the bot. The bot has exactly 3 commands:
 *
 *   /new    → open a menu with all options (reseller / quantity / price) + Submit button
 *   /daily  → send today's stats (units, revenue, profit, breakdown)
 *   /stats  → send all-time stats (total units, revenue, profit, top reseller, days active)
 *
 * The Submit button (callback "submit") saves the sale and the dashboard
 * auto-updates within 4 seconds via polling.
 */
export async function POST(req: NextRequest) {
  const update = await req.json();

  // === AUTHORIZATION: Only allow the owner (chat_id 7281195843) ===
  const ownerId = Number(process.env.TELEGRAM_CHAT_ID || "7281195843");
  const updateChatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id || update.callback_query?.from?.id;
  if (updateChatId && Number(updateChatId) !== ownerId) {
    // Unauthorized user — send a rejection message and stop
    const tgToken = process.env.TELEGRAM_BOT_TOKEN || "8992554756:AAHIdtvD7caRbnO8ybQtJSJNTNuT1cXJIx8";
    if (update.message?.chat?.id) {
      await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: update.message.chat.id,
          text: "⛔ <b>Access Denied.</b>\n\nThis is a private bot. You are not authorized to use it.",
          parse_mode: "HTML",
        }),
      });
    }
    return NextResponse.json({ ok: true });
  }

  try {
    // ----- Callback query (button tap) -----
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat?.id;
      const fromId = cq.from?.id;
      const data = cq.data as string;
      const messageId = cq.message?.message_id;

      if (!chatId || !fromId || !data) {
        return NextResponse.json({ ok: true });
      }

      const state = getConversation(fromId);

      // Cancel
      if (data === "cancel") {
        clearConversation(fromId);
        if (messageId) {
          await editMessageText(
            chatId,
            messageId,
            "❌ Unit entry cancelled.\nSend /new to start again."
          );
        }
        await answerCallbackQuery(cq.id, "Cancelled");
        return NextResponse.json({ ok: true });
      }

      // /sales calendar — close button
      if (data === "sales_close" || data === "sclose") {
        if (messageId) {
          await editMessageText(
            chatId,
            messageId,
            "📋 Units manager closed.\nSend /sale to open it again."
          );
        }
        await answerCallbackQuery(cq.id, "Closed");
        return NextResponse.json({ ok: true });
      }

      // /sales list — refresh button (legacy, kept for backward-compat)
      if (data === "sales_refresh") {
        const sales = await fetchTodaySales();
        if (messageId) {
          await editMessageText(
            chatId,
            messageId,
            salesListText(sales),
            buildSalesListKeyboard(sales)
          );
        }
        await answerCallbackQuery(cq.id, "Refreshed");
        return NextResponse.json({ ok: true });
      }

      // Legacy delete (old /sale list) — still works if a stale button is tapped.
      if (data.startsWith("del_")) {
        const saleId = data.slice("del_".length);
        const sale = await db.sale.findUnique({ where: { id: saleId } });
        if (!sale) {
          await answerCallbackQuery(cq.id, "Unit not found (already deleted?)");
          return NextResponse.json({ ok: true });
        }

        await db.sale.delete({ where: { id: saleId } });
        void backupAfterEdit();
        await answerCallbackQuery(
          cq.id,
          `Deleted: ${sale.resellerName} · ${sale.quantity}×${sale.pricePerUnit}`
        );
        if (messageId) {
          await editMessageText(
            chatId,
            messageId,
            `✅ <b>Unit deleted</b>: ${escapeHtml(sale.resellerName)} · ${sale.quantity}×${formatPKR(sale.pricePerUnit)} (was ${formatPKR(sale.revenue)} rev, ${formatPKR(sale.profit)} profit)`
          );
        }
        return NextResponse.json({ ok: true });
      }

      // Legacy /pay list — close button (kept so stale buttons don't 404).
      if (data === "pay_close") {
        if (messageId) {
          await editMessageText(
            chatId,
            messageId,
            "💳 Payments list closed.\nUse /sale to manage payments now."
          );
        }
        await answerCallbackQuery(cq.id, "Closed");
        return NextResponse.json({ ok: true });
      }

      // Legacy /pay list — refresh button
      if (data === "pay_refresh") {
        const sales = await fetchTodaySales();
        if (messageId) {
          await editMessageText(
            chatId,
            messageId,
            paymentListText(sales),
            buildPaymentKeyboard(sales)
          );
        }
        await answerCallbackQuery(cq.id, "Refreshed");
        return NextResponse.json({ ok: true });
      }

      // Legacy /pay list — toggle a sale's payment status
      if (data.startsWith("paytoggle_")) {
        const saleId = data.slice("paytoggle_".length);
        const sale = await db.sale.findUnique({ where: { id: saleId } });
        if (!sale) {
          await answerCallbackQuery(cq.id, "Unit not found (deleted?)");
          return NextResponse.json({ ok: true });
        }

        const next: PaymentStatus =
          sale.paymentStatus === "done" ? "processing" : "done";
        await db.sale.update({
          where: { id: saleId },
          data: { paymentStatus: next },
        });
        void backupAfterEdit();
        await answerCallbackQuery(
          cq.id,
          `${sale.resellerName}: ${formatPayment(next)}`
        );
        return NextResponse.json({ ok: true });
      }

      // Custom-name path
      if (data === "custom_name") {
        state.step = "custom_name";
        setConversation(fromId, state);
        await answerCallbackQuery(cq.id, "Type the reseller name");
        await sendMessage(
          chatId,
          "✍️ Send me the <b>Reseller Name</b> as a text message."
        );
        return NextResponse.json({ ok: true });
      }

      // Custom-quantity path
      if (data === "custom_qty") {
        state.step = "custom_qty";
        setConversation(fromId, state);
        await answerCallbackQuery(cq.id, "Type the quantity");
        await sendMessage(
          chatId,
          "✍️ Send me the <b>Quantity</b> as a positive whole number (e.g. <code>7</code> or <code>10</code>):"
        );
        return NextResponse.json({ ok: true });
      }

      // Custom-price path
      if (data === "custom_price") {
        state.step = "custom_price";
        setConversation(fromId, state);
        await answerCallbackQuery(cq.id, "Type the price per unit");
        await sendMessage(
          chatId,
          "✍️ Send me the <b>Price per Unit</b> (PKR) as a positive whole number (e.g. <code>450</code> or <code>700</code>):"
        );
        return NextResponse.json({ ok: true });
      }

      // Gemini link path — let the user type an activation link.
      // (Optional field; user can also tap "Skip" to leave it blank.)
      if (data === "custom_link") {
        state.step = "custom_link";
        setConversation(fromId, state);
        await answerCallbackQuery(cq.id, "Send the activation link");
        const current = state.geminiLink && state.geminiLink.length > 0
          ? `\nCurrent link: <code>${escapeHtml(state.geminiLink)}</code>\n`
          : "";
        await sendMessage(
          chatId,
          "🔗 <b>Activation Link</b>\n" +
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
            "Send me the Gemini activation link as your next message.\n" +
            current +
            "Type <code>skip</code> to leave it blank, or <code>cancel</code> to abort."
        );
        return NextResponse.json({ ok: true });
      }

      // Skip link — clear the link and return to the /new menu.
      if (data === "skip_link") {
        state.geminiLink = "";
        state.step = "menu";
        setConversation(fromId, state);
        await answerCallbackQuery(cq.id, "Link skipped");
        await refreshMenu(chatId, messageId, fromId);
        return NextResponse.json({ ok: true });
      }

      // Submit
      if (data === "submit") {
        if (!state.resellerName || !state.quantity || !state.price || !state.payment) {
          await answerCallbackQuery(
            cq.id,
            "Pick reseller, quantity, price AND payment first ⚠️"
          );
          return NextResponse.json({ ok: true });
        }

        const revenue = state.quantity * state.price;
        const profit = (state.price - COST_PER_UNIT) * state.quantity;

        // If `state.addDate` is set (from the /sale calendar "Add Units to This
        // Day" button), override the sale's date to that PKT day, but preserve
        // the current PKT time-of-day so the sale shows up at a sensible hour
        // within the chosen day rather than at midnight.
        let saleDate: Date | undefined;
        let addDate: { year: number; month: number; day: number } | undefined;
        if (state.addDate) {
          const midnight = pktMidnightUtc(
            state.addDate.year,
            state.addDate.month,
            state.addDate.day
          );
          const timeOfDayOffset = Date.now() - startOfTodayPkt().getTime();
          saleDate = new Date(midnight.getTime() + timeOfDayOffset);
          addDate = state.addDate;
        }

        const sale = await db.sale.create({
          data: {
            resellerName: state.resellerName,
            quantity: state.quantity,
            pricePerUnit: state.price,
            revenue,
            profit,
            paymentStatus: state.payment,
            geminiLink: state.geminiLink || "",
            ...(saleDate ? { date: saleDate } : {}),
          },
        });

        // Persist a backup snapshot so we never lose a sale to a crash.
        void backupAfterSale();

        clearConversation(fromId);
        await answerCallbackQuery(cq.id, "Saved! ✅");

        const linkLine = sale.geminiLink && sale.geminiLink.length > 0
          ? `🔗 Link:      <code>${escapeHtml(sale.geminiLink)}</code>\n`
          : "";
        const dateLine = saleDate
          ? `🕐 Time:      <b>${formatPktDateTime(saleDate)}</b> PKT\n`
          : `🕐 Time:      <b>${formatPktDateTime(sale.date)}</b> PKT\n`;

        const confirmation =
          `✅ <b>UNIT SAVED</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `👤 Reseller:  <b>${escapeHtml(sale.resellerName)}</b>\n` +
          `📦 Quantity:  <b>${sale.quantity}</b> units\n` +
          `💵 Price:     <b>${formatPKR(sale.pricePerUnit)}/unit</b>\n` +
          `💰 Revenue:   <b>${formatPKR(sale.revenue)}</b>\n` +
          `🎯 Profit:    <b>${formatPKR(sale.profit)}</b>  <i>(cost 250/unit)</i>\n` +
          `💳 Payment:   <b>${formatPayment(sale.paymentStatus as PaymentStatus)}</b>\n` +
          linkLine +
          dateLine +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `📊 Dashboard auto-updated.\n\nSend /new to log another unit.`;

        if (messageId) {
          await editMessageText(chatId, messageId, confirmation);
        } else {
          await sendMessage(chatId, confirmation);
        }

        // If this sale was added to a specific calendar day (via /sale →
        // "Add Units to This Day"), re-render that day's detail view so the
        // user immediately sees the new entry in context.
        if (addDate) {
          await renderSalesCalendarDay(
            chatId,
            undefined,
            addDate.year,
            addDate.month,
            addDate.day
          );
        }
        return NextResponse.json({ ok: true });
      }

      // Payment (in /new menu) — Done / Processing
      if (data === "pay_done" || data === "pay_processing") {
        state.payment = data === "pay_done" ? "done" : "processing";
        state.step = "menu";
        setConversation(fromId, state);
        await answerCallbackQuery(cq.id, `Payment: ${formatPayment(state.payment)}`);
        await refreshMenu(chatId, messageId, fromId);
        return NextResponse.json({ ok: true });
      }

      // Reseller button
      if (data.startsWith("reseller_")) {
        const name = data.slice("reseller_".length);
        state.resellerName = name;
        state.step = "menu";
        setConversation(fromId, state);
        await answerCallbackQuery(cq.id, `Reseller: ${name}`);
        await refreshMenu(chatId, messageId, fromId);
        return NextResponse.json({ ok: true });
      }

      // Quantity button
      if (data.startsWith("qty_")) {
        const q = Number(data.slice("qty_".length));
        if (!Number.isInteger(q) || q <= 0) {
          await answerCallbackQuery(cq.id, "Invalid quantity");
          return NextResponse.json({ ok: true });
        }
        state.quantity = q;
        state.step = "menu";
        setConversation(fromId, state);
        await answerCallbackQuery(cq.id, `Quantity: ${q}`);
        await refreshMenu(chatId, messageId, fromId);
        return NextResponse.json({ ok: true });
      }

      // Price button
      if (data.startsWith("price_")) {
        const p = Number(data.slice("price_".length));
        if (!ALLOWED_PRICES.includes(p as (typeof ALLOWED_PRICES)[number])) {
          await answerCallbackQuery(cq.id, "Invalid price");
          return NextResponse.json({ ok: true });
        }
        state.price = p;
        state.step = "menu";
        setConversation(fromId, state);
        await answerCallbackQuery(cq.id, `Price: ${p} PKR`);
        await refreshMenu(chatId, messageId, fromId);
        return NextResponse.json({ ok: true });
      }

      // ============================================================
      // CALENDAR CALLBACKS (for /stats)
      // ============================================================

      // No-op (used for weekday labels + padding in calendar grid)
      if (data === "noop") {
        await answerCallbackQuery(cq.id);
        return NextResponse.json({ ok: true });
      }

      // Close calendar
      if (data === "cal_close") {
        if (messageId) {
          await editMessageText(
            chatId,
            messageId,
            "📅 Calendar closed.\nSend /stats to open it again."
          );
        }
        await answerCallbackQuery(cq.id, "Closed");
        return NextResponse.json({ ok: true });
      }

      // Year change: `cy_<year>` — show months for the selected year
      if (data.startsWith("cy_") || data.startsWith("cb_year_")) {
        const prefix = data.startsWith("cy_") ? "cy_" : "cb_year_";
        const year = Number(data.slice(prefix.length));
        if (!Number.isInteger(year) || year < 2020 || year > 2100) {
          await answerCallbackQuery(cq.id, "Invalid year");
          return NextResponse.json({ ok: true });
        }
        await answerCallbackQuery(cq.id);
        await renderCalendarYear(chatId, messageId, year);
        return NextResponse.json({ ok: true });
      }

      // Month select: `cm_<year>_<month>` — show day grid for that month
      if (data.startsWith("cm_")) {
        const parts = data.slice("cm_".length).split("_");
        const year = Number(parts[0]);
        const month = Number(parts[1]);
        if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
          await answerCallbackQuery(cq.id, "Invalid month");
          return NextResponse.json({ ok: true });
        }
        await answerCallbackQuery(cq.id);
        await renderCalendarMonth(chatId, messageId, year, month);
        return NextResponse.json({ ok: true });
      }

      // Day select: `cd_<year>_<month>_<day>` — show that day's full sales
      if (data.startsWith("cd_")) {
        const parts = data.slice("cd_".length).split("_");
        const year = Number(parts[0]);
        const month = Number(parts[1]);
        const day = Number(parts[2]);
        if (
          !Number.isInteger(year) ||
          !Number.isInteger(month) ||
          !Number.isInteger(day) ||
          month < 1 || month > 12 ||
          day < 1 || day > 31
        ) {
          await answerCallbackQuery(cq.id, "Invalid day");
          return NextResponse.json({ ok: true });
        }
        await answerCallbackQuery(cq.id);
        await renderCalendarDay(chatId, messageId, year, month, day);
        return NextResponse.json({ ok: true });
      }

      // Monthly overview: `mo_<year>_<month>` — full month summary
      if (data.startsWith("mo_")) {
        const parts = data.slice("mo_".length).split("_");
        const year = Number(parts[0]);
        const month = Number(parts[1]);
        if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
          await answerCallbackQuery(cq.id, "Invalid month");
          return NextResponse.json({ ok: true });
        }
        await answerCallbackQuery(cq.id);
        const text = await buildMonthOverviewText(year, month);
        // Re-render the month keyboard so the user can navigate back
        await editMessageText(chatId, messageId!, text, buildCalendarDayKeyboard(year, month));
        return NextResponse.json({ ok: true });
      }

      // Weekly breakdown: `wb_<year>_<month>` — week-by-week stats for the month
      if (data.startsWith("wb_")) {
        const parts = data.slice("wb_".length).split("_");
        const year = Number(parts[0]);
        const month = Number(parts[1]);
        if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
          await answerCallbackQuery(cq.id, "Invalid month");
          return NextResponse.json({ ok: true });
        }
        await answerCallbackQuery(cq.id);
        const text = await buildWeeklyBreakdownText(year, month);
        await editMessageText(chatId, messageId!, text, buildCalendarDayKeyboard(year, month));
        return NextResponse.json({ ok: true });
      }

      // ============================================================
      // PAYMENT CALENDAR CALLBACKS (for /pay)
      // ============================================================

      // Pay year change: `py_<year>` or `pb_year_<year>`
      if (data.startsWith("py_") || data.startsWith("pb_year_")) {
        const prefix = data.startsWith("py_") ? "py_" : "pb_year_";
        const year = Number(data.slice(prefix.length));
        if (!Number.isInteger(year) || year < 2020 || year > 2100) {
          await answerCallbackQuery(cq.id, "Invalid year");
          return NextResponse.json({ ok: true });
        }
        await answerCallbackQuery(cq.id);
        await renderPayCalendarYear(chatId, messageId, year);
        return NextResponse.json({ ok: true });
      }

      // Pay month select: `pm_<year>_<month>` — show day grid with payment badges
      if (data.startsWith("pm_")) {
        const parts = data.slice("pm_".length).split("_");
        const year = Number(parts[0]);
        const month = Number(parts[1]);
        if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
          await answerCallbackQuery(cq.id, "Invalid month");
          return NextResponse.json({ ok: true });
        }
        await answerCallbackQuery(cq.id);
        await renderPayCalendarMonth(chatId, messageId, year, month);
        return NextResponse.json({ ok: true });
      }

      // Pay day select: `pd_<year>_<month>_<day>` — show that day's sales + toggle buttons
      if (data.startsWith("pd_")) {
        const parts = data.slice("pd_".length).split("_");
        const year = Number(parts[0]);
        const month = Number(parts[1]);
        const day = Number(parts[2]);
        if (
          !Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) ||
          month < 1 || month > 12 || day < 1 || day > 31
        ) {
          await answerCallbackQuery(cq.id, "Invalid day");
          return NextResponse.json({ ok: true });
        }
        await answerCallbackQuery(cq.id);
        await renderPayCalendarDay(chatId, messageId, year, month, day);
        return NextResponse.json({ ok: true });
      }

      // Pay month overview: `pmo_<year>_<month>`
      if (data.startsWith("pmo_")) {
        const parts = data.slice("pmo_".length).split("_");
        const year = Number(parts[0]);
        const month = Number(parts[1]);
        if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
          await answerCallbackQuery(cq.id, "Invalid month");
          return NextResponse.json({ ok: true });
        }
        await answerCallbackQuery(cq.id);
        const text = await buildPayMonthOverviewText(year, month);
        await editMessageText(chatId, messageId!, text, buildCalendarDayKeyboard(year, month));
        return NextResponse.json({ ok: true });
      }

      // Pay toggle (from /pay day view): `ptoggle_<saleId>` (legacy)
      if (data.startsWith("ptoggle_")) {
        const saleId = data.slice("ptoggle_".length);
        const sale = await db.sale.findUnique({ where: { id: saleId } });
        if (!sale) {
          await answerCallbackQuery(cq.id, "Unit not found (deleted?)");
          return NextResponse.json({ ok: true });
        }

        const next: PaymentStatus =
          sale.paymentStatus === "done" ? "processing" : "done";
        await db.sale.update({ where: { id: saleId }, data: { paymentStatus: next } });
        void backupAfterEdit();
        await answerCallbackQuery(
          cq.id,
          `${sale.resellerName}: ${formatPayment(next)}`
        );

        // Re-render the day view (extract date from sale.date)
        const d = new Date(sale.date);
        await renderPayCalendarDay(chatId, messageId, d.getFullYear(), d.getMonth() + 1, d.getDate());
        return NextResponse.json({ ok: true });
      }

      // ============================================================
      // SALES CALENDAR CALLBACKS (for /sale command — merged /pay flow)
      // ============================================================

      // /sales year change: `scy_<year>` or `scb_year_<year>`
      if (data.startsWith("scy_") || data.startsWith("scb_year_")) {
        const prefix = data.startsWith("scy_") ? "scy_" : "scb_year_";
        const year = Number(data.slice(prefix.length));
        if (!Number.isInteger(year) || year < 2020 || year > 2100) {
          await answerCallbackQuery(cq.id, "Invalid year");
          return NextResponse.json({ ok: true });
        }
        await answerCallbackQuery(cq.id);
        await renderSalesCalendarYear(chatId, messageId, year);
        return NextResponse.json({ ok: true });
      }

      // /sales month select: `scm_<year>_<month>` — show day grid
      if (data.startsWith("scm_")) {
        const parts = data.slice("scm_".length).split("_");
        const year = Number(parts[0]);
        const month = Number(parts[1]);
        if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
          await answerCallbackQuery(cq.id, "Invalid month");
          return NextResponse.json({ ok: true });
        }
        await answerCallbackQuery(cq.id);
        await renderSalesCalendarMonth(chatId, messageId, year, month);
        return NextResponse.json({ ok: true });
      }

      // /sales day select: `scd_<year>_<month>_<day>` — show day detail with sale buttons
      if (data.startsWith("scd_")) {
        const parts = data.slice("scd_".length).split("_");
        const year = Number(parts[0]);
        const month = Number(parts[1]);
        const day = Number(parts[2]);
        if (
          !Number.isInteger(year) ||
          !Number.isInteger(month) ||
          !Number.isInteger(day) ||
          month < 1 || month > 12 ||
          day < 1 || day > 31
        ) {
          await answerCallbackQuery(cq.id, "Invalid day");
          return NextResponse.json({ ok: true });
        }
        await answerCallbackQuery(cq.id);
        await renderSalesCalendarDay(chatId, messageId, year, month, day);
        return NextResponse.json({ ok: true });
      }

      // /sales action menu: `sact_<saleId>` — show action menu for a specific sale
      if (data.startsWith("sact_")) {
        const saleId = data.slice("sact_".length);
        await answerCallbackQuery(cq.id);
        await renderSalesActionMenu(chatId, messageId, saleId);
        return NextResponse.json({ ok: true });
      }

      // /sales back to day grid (from action menu): `sback_<year>_<month>`
      // We need the day too — read it from the conversation state.
      if (data.startsWith("sback_")) {
        const parts = data.slice("sback_".length).split("_");
        const year = Number(parts[0]);
        const month = Number(parts[1]);
        const day = state.pendingSaleDay ?? 1;
        if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
          await answerCallbackQuery(cq.id, "Invalid month");
          return NextResponse.json({ ok: true });
        }
        await answerCallbackQuery(cq.id);
        await renderSalesCalendarDay(chatId, messageId, year, month, day);
        return NextResponse.json({ ok: true });
      }

      // /sales start delete: `sdel_<saleId>` — ask user to type DELETE
      if (data.startsWith("sdel_")) {
        const saleId = data.slice("sdel_".length);
        const sale = await db.sale.findUnique({ where: { id: saleId } });
        if (!sale) {
          await answerCallbackQuery(cq.id, "Unit not found (deleted?)");
          return NextResponse.json({ ok: true });
        }
        // Remember the sale context so the text handler can complete the delete.
        const d = new Date(sale.date);
        const pkt = pktParts(d);
        state.step = "confirm_delete";
        state.pendingSaleId = saleId;
        state.pendingSaleYear = pkt.year;
        state.pendingSaleMonth = pkt.month;
        state.pendingSaleDay = pkt.day;
        setConversation(fromId, state);
        await answerCallbackQuery(cq.id, "Type DELETE to confirm");
        await sendMessage(
          chatId,
          `🗑 <b>Confirm delete</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `You're about to delete:\n` +
            `📦 <b>${escapeHtml(sale.resellerName)}</b> · ${sale.quantity}×${formatPKR(sale.pricePerUnit)} = ${formatPKR(sale.revenue)}\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `Type <code>DELETE</code> (in caps) as your next message to confirm.\n` +
            `Type anything else to cancel.`
        );
        return NextResponse.json({ ok: true });
      }

      // /sales start edit link: `sedit_<saleId>` — ask user for new Gemini link
      if (data.startsWith("sedit_")) {
        const saleId = data.slice("sedit_".length);
        const sale = await db.sale.findUnique({ where: { id: saleId } });
        if (!sale) {
          await answerCallbackQuery(cq.id, "Unit not found (deleted?)");
          return NextResponse.json({ ok: true });
        }
        const d = new Date(sale.date);
        const pkt = pktParts(d);
        state.step = "edit_link";
        state.pendingSaleId = saleId;
        state.pendingSaleYear = pkt.year;
        state.pendingSaleMonth = pkt.month;
        state.pendingSaleDay = pkt.day;
        setConversation(fromId, state);
        await answerCallbackQuery(cq.id, "Send the new link");
        const currentLink = sale.geminiLink && sale.geminiLink.length > 0
          ? `\nCurrent link: <code>${escapeHtml(sale.geminiLink)}</code>\n`
          : "\nNo link currently set.\n";
        await sendMessage(
          chatId,
          `✏️ <b>Edit activation link</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `For: <b>${escapeHtml(sale.resellerName)}</b> · ${sale.quantity}×${formatPKR(sale.pricePerUnit)}\n` +
            currentLink +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `Send the new Gemini link as your next message.\n` +
            `Type <code>cancel</code> to abort.`
        );
        return NextResponse.json({ ok: true });
      }

      // /sales toggle payment: `sptog_<saleId>` — flip Done ↔ Processing
      if (data.startsWith("sptog_")) {
        const saleId = data.slice("sptog_".length);
        const sale = await db.sale.findUnique({ where: { id: saleId } });
        if (!sale) {
          await answerCallbackQuery(cq.id, "Unit not found (deleted?)");
          return NextResponse.json({ ok: true });
        }
        const next: PaymentStatus =
          sale.paymentStatus === "done" ? "processing" : "done";
        await db.sale.update({ where: { id: saleId }, data: { paymentStatus: next } });
        void backupAfterEdit();
        await answerCallbackQuery(
          cq.id,
          `${sale.resellerName}: ${formatPayment(next)}`
        );
        // Re-render the action menu with the new payment status
        await renderSalesActionMenu(chatId, messageId, saleId);
        return NextResponse.json({ ok: true });
      }

      // /sales "Add Units to This Day" — `sadd_<year>_<month>_<day>`
      // Opens the /new menu flow with `state.addDate` set so the submitted
      // sale is back-dated to this specific PKT calendar day. The user can
      // pick reseller / qty / price / payment / link exactly as in /new.
      if (data.startsWith("sadd_")) {
        const parts = data.slice("sadd_".length).split("_");
        const year = Number(parts[0]);
        const month = Number(parts[1]);
        const day = Number(parts[2]);
        if (
          !Number.isInteger(year) ||
          !Number.isInteger(month) ||
          !Number.isInteger(day) ||
          month < 1 || month > 12 ||
          day < 1 || day > 31
        ) {
          await answerCallbackQuery(cq.id, "Invalid day");
          return NextResponse.json({ ok: true });
        }
        // Reset to a fresh /new-style menu state, but stamp the target date.
        const freshState: ConversationState = {
          step: "menu",
          addDate: { year, month, day },
        };
        setConversation(fromId, freshState);
        await answerCallbackQuery(
          cq.id,
          `Adding units to ${year}-${month}-${day}`
        );
        const dateLabel = pktMidnightUtc(year, month, day).toLocaleDateString(
          "en-US",
          { timeZone: "Asia/Karachi", weekday: "long", month: "long", day: "numeric", year: "numeric" }
        );
        const intro =
          `➕ <b>ADD UNITS TO THIS DAY</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `📅 <b>${escapeHtml(dateLabel)}</b> (PKT)\n\n` +
          `Pick reseller / qty / price / payment / link below, then press <b>Submit</b>.\n` +
          `The new unit will be recorded on this date at the current PKT time-of-day.\n\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        await sendMessage(chatId, intro);
        const res = await sendMessage(chatId, menuText(freshState), {
          reply_markup: buildMenuKeyboard(freshState),
        });
        if (res?.ok && res.result?.message_id) {
          freshState.messageId = res.result.message_id;
          setConversation(fromId, freshState);
        }
        return NextResponse.json({ ok: true });
      }

      // /resellers tap-to-view: `resview_<name>`
      if (data.startsWith("resview_")) {
        const name = data.slice("resview_".length);
        await answerCallbackQuery(cq.id, `Loading ${name}...`);
        await sendResellerHistory(chatId, name, messageId);
        return NextResponse.json({ ok: true });
      }

      // /resellers back button
      if (data === "resellers_back") {
        await answerCallbackQuery(cq.id, "Back");
        await sendResellersList(chatId);
        return NextResponse.json({ ok: true });
      }

      // /resellers analysis report: `ran_<name>_<period>` — ON-DEMAND file with revenue+profit+links
      if (data.startsWith("ran_")) {
        const rest = data.slice(4);
        const lastUnderscore = rest.lastIndexOf("_");
        if (lastUnderscore === -1) {
          await answerCallbackQuery(cq.id, "Error");
          return NextResponse.json({ ok: true });
        }
        const name = rest.slice(0, lastUnderscore);
        const period = rest.slice(lastUnderscore + 1) as "daily" | "weekly" | "monthly" | "all";
        await answerCallbackQuery(cq.id, `Generating ${period} analysis...`);

        // Fetch sales for this reseller + period
        const all = await db.sale.findMany({ where: { resellerName: { contains: name } }, orderBy: { date: "asc" } });
        const todayStart = startOfTodayPkt();
        const todayEnd = endOfTodayPkt();
        const weekStart = startOfRollingWeekPkt();
        const monthStart = startOfMonthPkt();
        const monthEnd = endOfMonthPkt();
        let filtered = all;
        if (period === "daily") filtered = all.filter((s) => s.date >= todayStart && s.date < todayEnd);
        else if (period === "weekly") filtered = all.filter((s) => s.date >= weekStart && s.date < todayEnd);
        else if (period === "monthly") filtered = all.filter((s) => s.date >= monthStart && s.date < monthEnd);

        const saleRows: SaleRow[] = filtered.map((s) => ({
          id: s.id, date: s.date.toISOString(), resellerName: s.resellerName,
          quantity: s.quantity, pricePerUnit: s.pricePerUnit, revenue: s.revenue,
          profit: s.profit, paymentStatus: s.paymentStatus as PaymentStatus, geminiLink: s.geminiLink ?? "",
        }));

        const periodLabel = period === "daily" ? "Daily (Today)" : period === "weekly" ? "Weekly (7 days)" : period === "monthly" ? "Monthly (Current)" : "All-Time";
        const generatedLabel = new Date().toLocaleString("en-US", { timeZone: "Asia/Karachi" }) + " PKT";
        const txt = buildResellerAnalysisReport(name, periodLabel, generatedLabel, saleRows);
        await sendTxtDocument(chatId, txt, `${name.replace(/\s+/g, "_")}-analysis-${period}.txt`);
        return NextResponse.json({ ok: true });
      }

      // /resellers share report: `rsh_<name>_<period>` — ON-DEMAND file WITHOUT revenue/profit, WITH links
      if (data.startsWith("rsh_")) {
        const rest = data.slice(4);
        const lastUnderscore = rest.lastIndexOf("_");
        if (lastUnderscore === -1) {
          await answerCallbackQuery(cq.id, "Error");
          return NextResponse.json({ ok: true });
        }
        const name = rest.slice(0, lastUnderscore);
        const period = rest.slice(lastUnderscore + 1) as "daily" | "weekly" | "monthly" | "all";
        await answerCallbackQuery(cq.id, `Generating ${period} report...`);

        const all = await db.sale.findMany({ where: { resellerName: { contains: name } }, orderBy: { date: "asc" } });
        const todayStart = startOfTodayPkt();
        const todayEnd = endOfTodayPkt();
        const weekStart = startOfRollingWeekPkt();
        const monthStart = startOfMonthPkt();
        const monthEnd = endOfMonthPkt();
        let filtered = all;
        if (period === "daily") filtered = all.filter((s) => s.date >= todayStart && s.date < todayEnd);
        else if (period === "weekly") filtered = all.filter((s) => s.date >= weekStart && s.date < todayEnd);
        else if (period === "monthly") filtered = all.filter((s) => s.date >= monthStart && s.date < monthEnd);

        const saleRows: SaleRow[] = filtered.map((s) => ({
          id: s.id, date: s.date.toISOString(), resellerName: s.resellerName,
          quantity: s.quantity, pricePerUnit: s.pricePerUnit, revenue: s.revenue,
          profit: s.profit, paymentStatus: s.paymentStatus as PaymentStatus, geminiLink: s.geminiLink ?? "",
        }));

        const periodLabel = period === "daily" ? "Daily (Today)" : period === "weekly" ? "Weekly (7 days)" : period === "monthly" ? "Monthly (Current)" : "All-Time";
        const generatedLabel = new Date().toLocaleString("en-US", { timeZone: "Asia/Karachi" }) + " PKT";
        const txt = buildResellerShareReport(name, periodLabel, generatedLabel, saleRows);
        await sendTxtDocument(chatId, txt, `${name.replace(/\s+/g, "_")}-report-${period}.txt`);
        return NextResponse.json({ ok: true });
      }

      // ============================================================
      // SETTINGS CALLBACKS (for /settings)
      // ============================================================
      //
      //   sete_<key>  → prompt for a new value via text (edit_setting step)
      //   sett_<key>  → toggle a boolean setting in place (no text prompt)
      //   setc        → close the settings menu

      if (data === "setc") {
        if (messageId) {
          await editMessageText(
            chatId,
            messageId,
            "⚙️ Settings menu closed.\nSend /settings to open it again."
          );
        }
        await answerCallbackQuery(cq.id, "Closed");
        return NextResponse.json({ ok: true });
      }

      if (data.startsWith("sete_")) {
        const key = data.slice("sete_".length);
        const def = SETTING_DEFS.find((d) => d.key === key);
        if (!def) {
          await answerCallbackQuery(cq.id, "Unknown setting");
          return NextResponse.json({ ok: true });
        }
        if (!isOwnerOrAdminAuthed(chatId, fromId)) {
          await answerCallbackQuery(cq.id, "Access denied");
          return NextResponse.json({ ok: true });
        }
        state.step = "edit_setting";
        state.editSettingKey = key;
        setConversation(fromId, state);
        const current = await getSetting(key);
        const currentDisplay = def.type === "password"
          ? (current ? "•••••••" : "<i>(not set)</i>")
          : `<code>${escapeHtml(current)}</code>`;
        await answerCallbackQuery(cq.id, `Editing ${def.label}`);
        await sendMessage(
          chatId,
          `⚙️ <b>Edit Setting</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `<b>${escapeHtml(def.label)}</b>\n` +
            `${escapeHtml(def.description)}\n` +
            `Type: <i>${def.type}</i>\n` +
            `Current: ${currentDisplay}\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `Send the new value as your next message.\n` +
            `Type <code>cancel</code> to abort.`
        );
        return NextResponse.json({ ok: true });
      }

      if (data.startsWith("sett_")) {
        const key = data.slice("sett_".length);
        const def = SETTING_DEFS.find((d) => d.key === key);
        if (!def || def.type !== "boolean") {
          await answerCallbackQuery(cq.id, "Invalid toggle");
          return NextResponse.json({ ok: true });
        }
        if (!isOwnerOrAdminAuthed(chatId, fromId)) {
          await answerCallbackQuery(cq.id, "Access denied");
          return NextResponse.json({ ok: true });
        }
        const current = (await getSetting(key)) === "true";
        await setSetting(key, current ? "false" : "true");
        void backupAfterEdit();
        await answerCallbackQuery(
          cq.id,
          `${def.label}: ${current ? "OFF" : "ON"}`
        );
        await sendSettingsMenu(chatId, fromId, messageId);
        return NextResponse.json({ ok: true });
      }

      // ============================================================
      // ADMIN PANEL CALLBACKS (for /admin)
      // ============================================================
      //
      //   asettings → open the /settings menu (admin already authed)
      //   astats     → admin stats overview (all-time)
      //   aresellers → admin resellers list
      //   apayments  → admin pending payments list
      //   abackup    → admin manual backup
      //   arestore   → admin manual restore
      //   awipe      → admin wipe all sales (with confirm)
      //   aclose     → admin close panel

      if (data.startsWith("a") && (data === "asettings" || data === "astats" || data === "aresellers" ||
          data === "apayments" || data === "abackup" || data === "arestore" ||
          data === "awipe" || data === "aclose")) {
        if (!isOwnerOrAdminAuthed(chatId, fromId)) {
          await answerCallbackQuery(cq.id, "Access denied");
          return NextResponse.json({ ok: true });
        }
        await answerCallbackQuery(cq.id);
        switch (data) {
          case "asettings":
            await sendSettingsMenu(chatId, fromId, messageId);
            break;
          case "astats":
            await sendAllTimeStats(chatId);
            break;
          case "aresellers":
            await sendResellersList(chatId);
            break;
          case "apayments":
            await sendPendingPayments(chatId);
            break;
          case "abackup":
            await manualBackup(chatId);
            break;
          case "arestore":
            await manualRestore(chatId);
            break;
          case "awipe":
            await adminWipeAllSales(chatId);
            break;
          case "aclose":
            if (messageId) {
              await editMessageText(
                chatId,
                messageId,
                "🔐 Admin panel closed.\nSend /admin to open it again."
              );
            } else {
              await sendMessage(chatId, "🔐 Admin panel closed.");
            }
            break;
        }
        return NextResponse.json({ ok: true });
      }

      // Unknown callback
      await answerCallbackQuery(cq.id);
      return NextResponse.json({ ok: true });
    }

    // ----- Text message -----
    if (update.message?.text) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const fromId = msg.from?.id ?? chatId;
      const text = msg.text.trim();
      // Strip optional @botname suffix from commands
      const cmd = text.split(" ")[0].split("@")[0];

      // /new — open the sale entry menu
      if (cmd === "/new") {
        const freshState = { step: "menu" as const };
        setConversation(fromId, freshState);
        const res = await sendMessage(chatId, menuText(freshState), {
          reply_markup: buildMenuKeyboard(freshState),
        });
        if (res?.ok && res.result?.message_id) {
          freshState.messageId = res.result.message_id;
          setConversation(fromId, freshState);
        }
        return NextResponse.json({ ok: true });
      }

      // /daily — today's stats
      if (cmd === "/daily") {
        await sendTodaySummary(chatId);
        return NextResponse.json({ ok: true });
      }

      // /stats — opens the sales calendar (year+month picker → day grid → day detail)
      // Also accepts /calendar as an alias
      if (cmd === "/stats" || cmd === "/calendar") {
        await sendStatsCalendar(chatId);
        return NextResponse.json({ ok: true });
      }

      // /sale — opens the UNITS MANAGER calendar (year+month picker → day grid → day detail with action buttons)
      // Also accepts /sales as an alias.
      if (cmd === "/sale" || cmd === "/sales") {
        await sendSalesCalendar(chatId);
        return NextResponse.json({ ok: true });
      }

      // /weekly — last 7 days rolling summary
      if (cmd === "/weekly") {
        await sendWeeklySummary(chatId);
        return NextResponse.json({ ok: true });
      }

      // /month — current month stats
      if (cmd === "/month") {
        await sendMonthSummary(chatId);
        return NextResponse.json({ ok: true });
      }

      // /top — top resellers leaderboard (all-time)
      if (cmd === "/top") {
        await sendTopResellers(chatId);
        return NextResponse.json({ ok: true });
      }

      // /undo — delete the most recent sale (for typos)
      if (cmd === "/undo") {
        await undoLastSale(chatId);
        return NextResponse.json({ ok: true });
      }

      // /reseller <name> — per-reseller history
      if (cmd === "/reseller") {
        const name = text.split(/\s+/).slice(1).join(" ").trim();
        if (!name) {
          await sendMessage(
            chatId,
            "⚠️ Usage: <code>/reseller &lt;name&gt;</code>\nExample: <code>/reseller Mehroz</code>"
          );
          return NextResponse.json({ ok: true });
        }
        await sendResellerHistory(chatId, name);
        return NextResponse.json({ ok: true });
      }

      // /export — download all sales as CSV
      if (cmd === "/export") {
        await exportCsv(chatId);
        return NextResponse.json({ ok: true });
      }

      // /backup — manually create a backup snapshot
      if (cmd === "/backup") {
        await manualBackup(chatId);
        return NextResponse.json({ ok: true });
      }

      // /restore — restore DB from the most recent backup
      if (cmd === "/restore") {
        await manualRestore(chatId);
        return NextResponse.json({ ok: true });
      }

      // /help — show full command reference (alias for welcome)
      if (cmd === "/help") {
        await sendWelcome(chatId);
        return NextResponse.json({ ok: true });
      }

      // /search <text> — search sales by reseller name, price, or date
      // If no argument provided, switch to "search_query" conversation step.
      if (cmd === "/search") {
        const arg = text.split(/\s+/).slice(1).join(" ").trim();
        if (!arg) {
          // Conversational mode: ask the user what to search, then wait for their reply
          const state = getConversation(fromId);
          state.step = "search_query";
          setConversation(fromId, state);
          await sendMessage(
            chatId,
            "🔍 <b>SEARCH SALES</b>\n" +
              "━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
              "What do you want to search for?\n\n" +
              "You can send any of these as your next message:\n" +
              "• <b>Reseller name</b> — e.g. <code>Mehroz</code> or <code>Salaar</code>\n" +
              "• <b>Price</b> — e.g. <code>550</code> or <code>400</code>\n" +
              "• <b>Date</b> — e.g. <code>4 june 2026</code> or <code>june 4</code> or <code>2026-06-04</code>\n" +
              "• <b>Month</b> — e.g. <code>june</code> or <code>2026-06</code>\n\n" +
              "Type your search below 👇"
          );
          return NextResponse.json({ ok: true });
        }
        await sendSearchResults(chatId, arg);
        return NextResponse.json({ ok: true });
      }

      // /report — generate 30-day CSV report
      if (cmd === "/report") {
        await sendReport(chatId);
        return NextResponse.json({ ok: true });
      }

      // /pending — list all sales with processing payment status (all-time)
      if (cmd === "/pending") {
        await sendPendingPayments(chatId);
        return NextResponse.json({ ok: true });
      }

      // /milestone — show business milestones reached
      if (cmd === "/milestone") {
        await sendMilestones(chatId);
        return NextResponse.json({ ok: true });
      }

      // /margins — profit margin analysis by price point
      if (cmd === "/margins") {
        await sendMargins(chatId);
        return NextResponse.json({ ok: true });
      }

      // /compare — compare two periods.
      // If no args, switch to "compare_query" conversation step and accept free text.
      if (cmd === "/compare") {
        const args = text.split(/\s+/).slice(1).join(" ").trim();
        if (!args) {
          const state = getConversation(fromId);
          state.step = "compare_query";
          setConversation(fromId, state);
          await sendMessage(
            chatId,
            "📊 <b>COMPARE PERIODS</b>\n" +
              "━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
              "What two periods do you want to compare?\n\n" +
              "Send your comparison as a single message. Examples:\n" +
              "• <code>June vs July</code>\n" +
              "• <code>June 2nd week vs July 2nd week</code>\n" +
              "• <code>June 3rd week vs June 4th week</code>\n" +
              "• <code>This week vs last week</code>\n" +
              "• <code>Today vs yesterday</code>\n" +
              "• <code>This month vs last month</code>\n\n" +
              "Type your comparison below 👇"
          );
          return NextResponse.json({ ok: true });
        }
        await sendCompare(chatId, args);
        return NextResponse.json({ ok: true });
      }

      // /resellers — list all resellers with tap-to-view buttons
      if (cmd === "/resellers") {
        await sendResellersList(chatId);
        return NextResponse.json({ ok: true });
      }

      // /revenue <period> — cash flow: collected vs outstanding
      if (cmd === "/revenue") {
        const period = text.split(/\s+/)[1]?.trim() ?? "this_month";
        await sendRevenueReport(chatId, period);
        return NextResponse.json({ ok: true });
      }

      // /settings — owner/admin configuration panel.
      // Gated to the owner chat id (7281195843) or any user who has previously
      // authenticated via /admin. Shows an inline-button menu of every setting
      // defined in SETTING_DEFS; tapping one prompts for a new value.
      if (cmd === "/settings") {
        if (!isOwnerOrAdminAuthed(chatId, fromId)) {
          await sendMessage(
            chatId,
            "⛔ <b>Access denied</b>\n" +
              "━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
              "Only the owner can use /settings.\n" +
              "Use /admin to authenticate first."
          );
          return NextResponse.json({ ok: true });
        }
        await sendSettingsMenu(chatId, fromId);
        return NextResponse.json({ ok: true });
      }

      // /admin — owner-only admin panel (password-gated).
      // The owner's chat id (7281195843) bypasses the password. Everyone else
      // must enter the password (stored in the `adminPassword` setting, default
      // "Iht@Admin"). On success, their fromId is added to adminAuthedUsers
      // so they don't need to re-authenticate until the server restarts.
      if (cmd === "/admin") {
        if (isOwnerOrAdminAuthed(chatId, fromId)) {
          await sendAdminPanel(chatId);
          return NextResponse.json({ ok: true });
        }
        // Not authed yet — ask for the password.
        const state = getConversation(fromId);
        state.step = "admin_password";
        setConversation(fromId, state);
        await sendMessage(
          chatId,
          "🔐 <b>ADMIN ACCESS</b>\n" +
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
            "Send the admin password as your next message.\n" +
            "Type <code>cancel</code> to abort."
        );
        return NextResponse.json({ ok: true });
      }

      // /saledit — alias for /sale (Units Manager calendar).
      // Convenience command so the welcome menu's "saledit" entry works.
      if (cmd === "/saledit") {
        await sendSalesCalendar(chatId);
        return NextResponse.json({ ok: true });
      }

      // Awaiting a custom reseller name?
      const state = getConversation(fromId);
      if (state.step === "custom_name") {
        if (text.length < 2) {
          await sendMessage(chatId, "⚠️ Name too short (min 2 chars). Try again:");
          return NextResponse.json({ ok: true });
        }
        state.resellerName = text;
        state.step = "menu";
        setConversation(fromId, state);
        await sendMessage(chatId, `✅ Reseller set to <b>${escapeHtml(text)}</b>`);
        await refreshMenu(chatId, state.messageId, fromId);
        return NextResponse.json({ ok: true });
      }

      // Awaiting a custom quantity?
      if (state.step === "custom_qty") {
        const q = Number(text.replace(/[^\d]/g, ""));
        if (!Number.isInteger(q) || q <= 0) {
          await sendMessage(chatId, "⚠️ Invalid quantity. Send a positive whole number (e.g. <code>7</code>):");
          return NextResponse.json({ ok: true });
        }
        if (q > 10000) {
          await sendMessage(chatId, "⚠️ Quantity too large (max 10,000). Try again:");
          return NextResponse.json({ ok: true });
        }
        state.quantity = q;
        state.step = "menu";
        setConversation(fromId, state);
        await sendMessage(chatId, `✅ Quantity set to <b>${q}</b>`);
        await refreshMenu(chatId, state.messageId, fromId);
        return NextResponse.json({ ok: true });
      }

      // Awaiting a custom price?
      if (state.step === "custom_price") {
        const p = Number(text.replace(/[^\d]/g, ""));
        if (!Number.isInteger(p) || p <= 0) {
          await sendMessage(chatId, "⚠️ Invalid price. Send a positive whole number (e.g. <code>450</code>):");
          return NextResponse.json({ ok: true });
        }
        if (p > 1000000) {
          await sendMessage(chatId, "⚠️ Price too large (max 10,00,000 PKR). Try again:");
          return NextResponse.json({ ok: true });
        }
        state.price = p;
        state.step = "menu";
        setConversation(fromId, state);
        await sendMessage(chatId, `✅ Price set to <b>${formatPKR(p)}/unit</b>`);
        await refreshMenu(chatId, state.messageId, fromId);
        return NextResponse.json({ ok: true });
      }

      // Awaiting a Gemini activation link (from /new → "Add Link")?
      if (state.step === "custom_link") {
        const trimmed = text.trim();
        if (trimmed.toLowerCase() === "cancel") {
          state.step = "menu";
          setConversation(fromId, state);
          await sendMessage(chatId, "❌ Link entry cancelled.");
          await refreshMenu(chatId, state.messageId, fromId);
          return NextResponse.json({ ok: true });
        }
        if (trimmed.toLowerCase() === "skip" || trimmed.toLowerCase() === "none") {
          state.geminiLink = "";
          state.step = "menu";
          setConversation(fromId, state);
          await sendMessage(chatId, "✅ Link skipped (no link set).");
          await refreshMenu(chatId, state.messageId, fromId);
          return NextResponse.json({ ok: true });
        }
        if (trimmed.length < 4) {
          await sendMessage(chatId, "⚠️ Link too short (min 4 chars). Try again, or send <code>skip</code>:");
          return NextResponse.json({ ok: true });
        }
        if (trimmed.length > 500) {
          await sendMessage(chatId, "⚠️ Link too long (max 500 chars). Try again, or send <code>skip</code>:");
          return NextResponse.json({ ok: true });
        }
        state.geminiLink = trimmed;
        state.step = "menu";
        setConversation(fromId, state);
        await sendMessage(
          chatId,
          `✅ Link set to:\n<code>${escapeHtml(trimmed)}</code>`
        );
        await refreshMenu(chatId, state.messageId, fromId);
        return NextResponse.json({ ok: true });
      }

      // Awaiting the admin password (from /admin)?
      if (state.step === "admin_password") {
        const trimmed = text.trim();
        clearConversation(fromId);
        if (trimmed.toLowerCase() === "cancel") {
          await sendMessage(chatId, "❌ Admin login cancelled.");
          return NextResponse.json({ ok: true });
        }
        const expected = await getSetting("adminPassword");
        if (trimmed !== expected) {
          await sendMessage(
            chatId,
            "⛔ <b>Wrong password.</b>\n\nUse /admin to try again."
          );
          return NextResponse.json({ ok: true });
        }
        // Success — authenticate the user and show the admin panel.
        if (!adminAuthedUsers.has(fromId)) {
          adminAuthedUsers.add(fromId);
        }
        await sendMessage(
          chatId,
          "✅ <b>Admin authenticated.</b>\nWelcome — opening the admin panel..."
        );
        await sendAdminPanel(chatId);
        return NextResponse.json({ ok: true });
      }

      // Awaiting a new value for a setting (from /settings → tap a setting)?
      if (state.step === "edit_setting" && state.editSettingKey) {
        const key = state.editSettingKey;
        const def = SETTING_DEFS.find((d) => d.key === key);
        if (!def) {
          clearConversation(fromId);
          await sendMessage(chatId, "⚠️ Unknown setting. Aborting.");
          return NextResponse.json({ ok: true });
        }
        const trimmed = text.trim();
        if (trimmed.toLowerCase() === "cancel") {
          clearConversation(fromId);
          await sendMessage(chatId, "❌ Setting edit cancelled.");
          await sendSettingsMenu(chatId, fromId);
          return NextResponse.json({ ok: true });
        }

        // Basic type-aware validation
        if (def.type === "number") {
          const n = Number(trimmed);
          if (!Number.isFinite(n) || n < 0) {
            await sendMessage(chatId, "⚠️ Invalid number. Try again, or send <code>cancel</code>:");
            return NextResponse.json({ ok: true });
          }
          await setSetting(key, String(n));
        } else if (def.type === "boolean") {
          // Boolean settings are normally edited via toggle buttons in the
          // settings menu, but we also accept "true"/"false"/"yes"/"no".
          const v = /^(true|yes|1|on)$/i.test(trimmed) ? "true" : "false";
          await setSetting(key, v);
        } else if (def.type === "time") {
          if (!/^\d{1,2}:\d{2}$/.test(trimmed)) {
            await sendMessage(
              chatId,
              "⚠️ Invalid time. Use 24h HH:MM format (e.g. <code>22:00</code>). Try again, or send <code>cancel</code>:"
            );
            return NextResponse.json({ ok: true });
          }
          await setSetting(key, trimmed);
        } else {
          // text / password / comma_list — accept anything non-empty.
          if (trimmed.length === 0) {
            await sendMessage(chatId, "⚠️ Empty value. Try again, or send <code>cancel</code>:");
            return NextResponse.json({ ok: true });
          }
          if (trimmed.length > 2000) {
            await sendMessage(chatId, "⚠️ Value too long (max 2000 chars). Try again, or send <code>cancel</code>:");
            return NextResponse.json({ ok: true });
          }
          await setSetting(key, trimmed);
        }

        clearConversation(fromId);
        // Mask passwords in the confirmation message.
        const display = def.type === "password" ? "•••••••" : escapeHtml(trimmed);
        await sendMessage(
          chatId,
          `✅ <b>Setting updated</b>\n${escapeHtml(def.label)}: <b>${display}</b>`
        );
        await sendSettingsMenu(chatId, fromId);
        return NextResponse.json({ ok: true });
      }

      // Awaiting a search query (from /search with no args)?
      if (state.step === "search_query") {
        clearConversation(fromId);
        await sendSearchResults(chatId, text);
        return NextResponse.json({ ok: true });
      }

      // Awaiting a compare query (from /compare with no args)?
      if (state.step === "compare_query") {
        clearConversation(fromId);
        await sendCompare(chatId, text);
        return NextResponse.json({ ok: true });
      }

      // Awaiting DELETE confirmation (from /sales action menu)?
      if (state.step === "confirm_delete" && state.pendingSaleId) {
        const saleId = state.pendingSaleId;
        const year = state.pendingSaleYear;
        const month = state.pendingSaleMonth;
        const day = state.pendingSaleDay;
        clearConversation(fromId);

        if (text.trim().toUpperCase() !== "DELETE") {
          await sendMessage(
            chatId,
            "❌ Delete cancelled — you didn't type DELETE.\n\nTap the unit again in /sale to retry."
          );
          return NextResponse.json({ ok: true });
        }

        const sale = await db.sale.findUnique({ where: { id: saleId } });
        if (!sale) {
          await sendMessage(chatId, "⚠️ Unit not found — it may already be deleted.");
          return NextResponse.json({ ok: true });
        }

        await db.sale.delete({ where: { id: saleId } });
        void backupAfterEdit();
        await sendMessage(
          chatId,
          `✅ <b>UNIT DELETED</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `👤 Reseller:  <b>${escapeHtml(sale.resellerName)}</b>\n` +
            `📦 Quantity:  <b>${sale.quantity}</b> units\n` +
            `💵 Price:     <b>${formatPKR(sale.pricePerUnit)}/unit</b>\n` +
            `💰 Revenue:   <b>${formatPKR(sale.revenue)}</b>\n` +
            `🎯 Profit:    <b>${formatPKR(sale.profit)}</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `📊 Dashboard auto-updated.`
        );
        // Re-render the day view so the user sees the updated list
        if (year && month && day) {
          await renderSalesCalendarDay(chatId, undefined, year, month, day);
        }
        return NextResponse.json({ ok: true });
      }

      // Awaiting a new Gemini link (from /sales action menu)?
      if (state.step === "edit_link" && state.pendingSaleId) {
        const saleId = state.pendingSaleId;
        const year = state.pendingSaleYear;
        const month = state.pendingSaleMonth;
        const day = state.pendingSaleDay;
        clearConversation(fromId);

        if (text.trim().toLowerCase() === "cancel") {
          await sendMessage(chatId, "❌ Edit link cancelled.");
          if (year && month && day) {
            await renderSalesCalendarDay(chatId, undefined, year, month, day);
          }
          return NextResponse.json({ ok: true });
        }

        // Basic validation — must look vaguely like a URL (contains a dot or "gemini")
        const trimmed = text.trim();
        if (trimmed.length < 4) {
          await sendMessage(chatId, "⚠️ Link too short. Edit cancelled — try again from /sale.");
          return NextResponse.json({ ok: true });
        }
        if (trimmed.length > 500) {
          await sendMessage(chatId, "⚠️ Link too long (max 500 chars). Edit cancelled — try again from /sale.");
          return NextResponse.json({ ok: true });
        }

        const sale = await db.sale.findUnique({ where: { id: saleId } });
        if (!sale) {
          await sendMessage(chatId, "⚠️ Unit not found — it may have been deleted.");
          return NextResponse.json({ ok: true });
        }

        await db.sale.update({ where: { id: saleId }, data: { geminiLink: trimmed } });
        void backupAfterEdit();
        await sendMessage(
          chatId,
          `✅ <b>Link updated</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `For: <b>${escapeHtml(sale.resellerName)}</b> · ${sale.quantity}×${formatPKR(sale.pricePerUnit)}\n` +
            `🔗 <code>${escapeHtml(trimmed)}</code>`
        );
        // Re-render the action menu so the new link is visible
        await renderSalesActionMenu(chatId, undefined, saleId);
        return NextResponse.json({ ok: true });
      }

      // /start or any unknown text → welcome message listing the 3 commands
      await sendWelcome(chatId);
      return NextResponse.json({ ok: true });
    }
  } catch (err) {
    console.error("Telegram webhook error:", err);
  }

  return NextResponse.json({ ok: true });
}

/** Re-render the menu message in place with the current state. */
async function refreshMenu(
  chatId: number,
  messageId: number | undefined,
  fromId: number
) {
  const state = getConversation(fromId);
  if (!messageId) {
    const res = await sendMessage(chatId, menuText(state), {
      reply_markup: buildMenuKeyboard(state),
    });
    if (res?.ok && res.result?.message_id) {
      state.messageId = res.result.message_id;
      setConversation(fromId, state);
    }
    return;
  }
  try {
    await editMessageText(
      chatId,
      messageId,
      menuText(state),
      buildMenuKeyboard(state)
    );
  } catch {
    const res = await sendMessage(chatId, menuText(state), {
      reply_markup: buildMenuKeyboard(state),
    });
    if (res?.ok && res.result?.message_id) {
      state.messageId = res.result.message_id;
      setConversation(fromId, state);
    }
  }
}

/** Fetch TODAY's sales (newest first), formatted as SaleRow. */
async function fetchTodaySales(): Promise<SaleRow[]> {
  const start = startOfTodayPkt();
  const end = endOfTodayPkt();

  const sales = await db.sale.findMany({
    where: { date: { gte: start, lt: end } },
    orderBy: { date: "desc" },
  });
  return sales.map((s) => ({
    id: s.id,
    date: s.date.toISOString(),
    resellerName: s.resellerName,
    quantity: s.quantity,
    pricePerUnit: s.pricePerUnit,
    revenue: s.revenue,
    profit: s.profit,
    paymentStatus: s.paymentStatus as PaymentStatus,
    geminiLink: s.geminiLink ?? "",
  }));
}

/** Send the /sale list message (today's units) with inline delete buttons.
 *  Kept for legacy `sales_refresh` callback compatibility. */
async function sendSalesList(chatId: number | string) {
  const sales = await fetchTodaySales();
  await sendMessage(chatId, salesListText(sales), {
    reply_markup: buildSalesListKeyboard(sales),
  });
}

/** Send the /pay list message (today's payments) with inline toggle buttons. */
async function sendPaymentList(chatId: number | string) {
  const sales = await fetchTodaySales();
  await sendMessage(chatId, paymentListText(sales), {
    reply_markup: buildPaymentKeyboard(sales),
  });
}

/** /weekly — last 7 days rolling summary. */
async function sendWeeklySummary(chatId: number | string) {
  const start = startOfRollingWeekPkt();

  const sales = await db.sale.findMany({
    where: { date: { gte: start } },
    orderBy: { date: "asc" },
  });

  if (sales.length === 0) {
    await sendMessage(chatId, "📭 No sales in the last 7 days (PKT).");
    return;
  }

  const totalUnits = sales.reduce((s, x) => s + x.quantity, 0);
  const totalRevenue = sales.reduce((s, x) => s + x.revenue, 0);
  const totalProfit = sales.reduce((s, x) => s + x.profit, 0);

  // Per-day buckets (PKT-aligned)
  const byDay = new Map<string, { units: number; revenue: number; profit: number }>();
  for (const s of sales) {
    const key = pktDateKey(s.date);
    const cur = byDay.get(key) ?? { units: 0, revenue: 0, profit: 0 };
    cur.units += s.quantity;
    cur.revenue += s.revenue;
    cur.profit += s.profit;
    byDay.set(key, cur);
  }

  // Per-reseller totals this week
  const byReseller = new Map<string, { units: number; revenue: number; profit: number; sales: number }>();
  for (const s of sales) {
    const cur = byReseller.get(s.resellerName) ?? { units: 0, revenue: 0, profit: 0, sales: 0 };
    cur.units += s.quantity;
    cur.revenue += s.revenue;
    cur.profit += s.profit;
    cur.sales += 1;
    byReseller.set(s.resellerName, cur);
  }
  const topWeek = Array.from(byReseller.entries()).sort((a, b) => b[1].units - a[1].units)[0];

  // Best day
  const bestDay = Array.from(byDay.entries()).sort((a, b) => b[1].profit - a[1].profit)[0];

  const lines: string[] = [];
  lines.push(`📅 <b>WEEKLY SUMMARY (last 7 days, PKT)</b>`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`✅ Total Units: <b>${totalUnits}</b>`);
  lines.push(`💵 Total Revenue: <b>${formatPKR(totalRevenue)}</b>`);
  lines.push(`🎯 Total Profit: <b>${formatPKR(totalProfit)}</b>`);
  lines.push(`📊 Avg Profit/Day: <b>${formatPKR(Math.round(totalProfit / 7))}</b>`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  if (topWeek) {
    lines.push(`🏆 TOP RESELLER (week): <b>${escapeHtml(topWeek[0])}</b> (${topWeek[1].units} units, ${formatPKR(topWeek[1].revenue)} rev)`);
  }
  if (bestDay) {
    lines.push(`💎 BEST DAY: <b>${bestDay[0]}</b> (${bestDay[1].units} units, ${formatPKR(bestDay[1].profit)} profit)`);
  }
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`📦 ALL RESELLERS THIS WEEK:`);
  for (const [name, v] of Array.from(byReseller.entries()).sort((a, b) => b[1].units - a[1].units)) {
    lines.push(`• ${escapeHtml(name)}: ${v.units} units · ${v.sales} sales · ${formatPKR(v.revenue)} rev · ${formatPKR(v.profit)} profit`);
  }
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  await sendMessage(chatId, lines.join("\n"));
}

/** /month — current month stats. */
async function sendMonthSummary(chatId: number | string) {
  const start = startOfMonthPkt();
  const end = endOfMonthPkt();

  const sales = await db.sale.findMany({
    where: { date: { gte: start, lt: end } },
    orderBy: { date: "asc" },
  });

  if (sales.length === 0) {
    await sendMessage(chatId, "📭 No sales this month (PKT) yet.");
    return;
  }

  const totalUnits = sales.reduce((s, x) => s + x.quantity, 0);
  const totalRevenue = sales.reduce((s, x) => s + x.revenue, 0);
  const totalProfit = sales.reduce((s, x) => s + x.profit, 0);
  const avgPrice = Math.round(totalRevenue / totalUnits);

  const byReseller = new Map<string, { units: number; revenue: number; profit: number; sales: number }>();
  for (const s of sales) {
    const cur = byReseller.get(s.resellerName) ?? { units: 0, revenue: 0, profit: 0, sales: 0 };
    cur.units += s.quantity;
    cur.revenue += s.revenue;
    cur.profit += s.profit;
    cur.sales += 1;
    byReseller.set(s.resellerName, cur);
  }
  const top = Array.from(byReseller.entries()).sort((a, b) => b[1].units - a[1].units)[0];

  const p = pktParts();
  const monthName = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Karachi",
    month: "long",
    year: "numeric",
  }).format(new Date());
  const daysInMonth = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
  const daysElapsed = p.day;
  const onPace = Math.round((totalProfit / daysElapsed) * daysInMonth);

  const lines: string[] = [];
  lines.push(`📆 <b>MONTHLY SUMMARY — ${monthName}</b> (PKT)`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`📅 Days elapsed: <b>${daysElapsed}/${daysInMonth}</b>`);
  lines.push(`🧾 Total sales: <b>${sales.length}</b>`);
  lines.push(`✅ Total Units: <b>${totalUnits}</b>`);
  lines.push(`💵 Total Revenue: <b>${formatPKR(totalRevenue)}</b>`);
  lines.push(`🎯 Total Profit: <b>${formatPKR(totalProfit)}</b>`);
  lines.push(`📊 Avg Price: <b>${formatPKR(avgPrice)}/unit</b>`);
  lines.push(`📈 On-pace for month: <b>${formatPKR(onPace)} profit</b>`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  if (top) {
    lines.push(`🏆 TOP RESELLER: <b>${escapeHtml(top[0])}</b> (${top[1].units} units, ${formatPKR(top[1].revenue)} rev)`);
  }
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`📦 ALL RESELLERS THIS MONTH:`);
  for (const [name, v] of Array.from(byReseller.entries()).sort((a, b) => b[1].units - a[1].units)) {
    lines.push(`• ${escapeHtml(name)}: ${v.units} units · ${v.sales} sales · ${formatPKR(v.revenue)} rev · ${formatPKR(v.profit)} profit`);
  }
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  await sendMessage(chatId, lines.join("\n"));
}

/** /top — all-time top resellers leaderboard. */
async function sendTopResellers(chatId: number | string) {
  const sales = await db.sale.findMany();
  if (sales.length === 0) {
    await sendMessage(chatId, "📭 No sales recorded yet.");
    return;
  }

  const byReseller = new Map<string, { units: number; revenue: number; profit: number; sales: number }>();
  for (const s of sales) {
    const cur = byReseller.get(s.resellerName) ?? { units: 0, revenue: 0, profit: 0, sales: 0 };
    cur.units += s.quantity;
    cur.revenue += s.revenue;
    cur.profit += s.profit;
    cur.sales += 1;
    byReseller.set(s.resellerName, cur);
  }
  const sorted = Array.from(byReseller.entries()).sort((a, b) => b[1].units - a[1].units);

  const medals = ["🥇", "🥈", "🥉"];
  const lines: string[] = [];
  lines.push(`🏆 <b>TOP RESELLERS (ALL-TIME)</b>`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  sorted.forEach(([name, v], i) => {
    const medal = medals[i] || `#${i + 1}`;
    lines.push(`${medal} <b>${escapeHtml(name)}</b>`);
    lines.push(`    ${v.units} units · ${v.sales} sales · ${formatPKR(v.revenue)} rev · ${formatPKR(v.profit)} profit`);
  });
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  await sendMessage(chatId, lines.join("\n"));
}

/** /undo — delete the most recent sale (for typos). */
async function undoLastSale(chatId: number | string) {
  const last = await db.sale.findFirst({ orderBy: { createdAt: "desc" } });
  if (!last) {
    await sendMessage(chatId, "⚠️ Nothing to undo — no sales recorded yet.");
    return;
  }

  await db.sale.delete({ where: { id: last.id } });
  void backupAfterEdit(); // auto-backup after undo
  void backupAfterSale();

  await sendMessage(
    chatId,
    `↩️ <b>SALE DELETED</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 Reseller:  <b>${escapeHtml(last.resellerName)}</b>\n` +
      `📦 Quantity:  <b>${last.quantity}</b> units\n` +
      `💵 Price:     <b>${formatPKR(last.pricePerUnit)}/unit</b>\n` +
      `💰 Revenue:   <b>${formatPKR(last.revenue)}</b>\n` +
      `🎯 Profit:    <b>${formatPKR(last.profit)}</b>\n` +
      `💳 Payment:   <b>${formatPayment(last.paymentStatus as PaymentStatus)}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 Dashboard auto-updated.`
  );
}

/** /reseller <name> — full history for one reseller.
 *  Sends two .txt files:
 *    1. Analysis report (owner's copy — with revenue, profit & links)
 *    2. Share report   (reseller's copy — no revenue/profit, with links)
 *  Plus a short chat summary of the reseller's stats. */
async function sendResellerHistory(chatId: number | string, name: string, messageId?: number) {
  // Show ONLY a button grid — no text breakdown, no auto-generated files
  const safeName = name.slice(0, 40);
  const text = `👤 <b>${escapeHtml(name)}</b>\nSelect an option:`;
  const keyboard = {
    inline_keyboard: [
      [
        { text: "📊 Daily Analysis", callback_data: `ran_${safeName}_daily` },
        { text: "📤 Daily Report", callback_data: `rsh_${safeName}_daily` },
      ],
      [
        { text: "📊 Weekly Analysis", callback_data: `ran_${safeName}_weekly` },
        { text: "📤 Weekly Report", callback_data: `rsh_${safeName}_weekly` },
      ],
      [
        { text: "📊 Monthly Analysis", callback_data: `ran_${safeName}_monthly` },
        { text: "📤 Monthly Report", callback_data: `rsh_${safeName}_monthly` },
      ],
      [
        { text: "📊 All-Time Analysis", callback_data: `ran_${safeName}_all` },
        { text: "📤 All-Time Report", callback_data: `rsh_${safeName}_all` },
      ],
      [
        { text: "◀ Back to Resellers", callback_data: "resellers_back" },
      ],
    ],
  };

  if (messageId) {
    try {
      await editMessageText(chatId, messageId, text, keyboard);
    } catch {
      await sendMessage(chatId, text, { reply_markup: keyboard });
    }
  } else {
    await sendMessage(chatId, text, { reply_markup: keyboard });
  }
}

/** Send a .txt document to a Telegram chat. */
async function sendTxtDocument(chatId: number | string, content: string, filename: string) {
  const formData = new FormData();
  formData.append("chat_id", String(chatId));
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  formData.append("document", blob, filename);
  const res = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN || "8992554756:AAHIdtvD7caRbnO8ybQtJSJNTNuT1cXJIx8"}/sendDocument`,
    {
      method: "POST",
      body: formData,
    }
  );
  const data = await res.json();
  if (!data.ok) {
    await sendMessage(chatId, `❌ Failed to send ${filename}: ${JSON.stringify(data)}`);
  }
}

/** /export — send all sales as a CSV file. */
async function exportCsv(chatId: number | string) {
  const sales = await db.sale.findMany({ orderBy: { date: "asc" } });
  if (sales.length === 0) {
    await sendMessage(chatId, "📭 No units to export yet.");
    return;
  }

  const header = "Date,Reseller,Quantity,Price Per Unit,Revenue,Profit,Payment Status,Gemini Link\n";
  const rows = sales
    .map((s) => {
      const dateStr = s.date.toISOString();
      const escapedName = `"${s.resellerName.replace(/"/g, '""')}"`;
      const escapedLink = `"${(s.geminiLink ?? "").replace(/"/g, '""')}"`;
      return `${dateStr},${escapedName},${s.quantity},${s.pricePerUnit},${s.revenue},${s.profit},${s.paymentStatus},${escapedLink}`;
    })
    .join("\n");
  const csv = header + rows + "\n";

  // Send via Telegram's sendDocument API
  const formData = new FormData();
  formData.append("chat_id", String(chatId));
  const blob = new Blob([csv], { type: "text/csv" });
  formData.append("document", blob, `gemini-units-${pktDateKey(new Date())}.csv`);

  const res = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN || "8992554756:AAHIdtvD7caRbnO8ybQtJSJNTNuT1cXJIx8"}/sendDocument`,
    {
      method: "POST",
      body: formData,
    }
  );
  const data = await res.json();
  if (!data.ok) {
    await sendMessage(chatId, `❌ Export failed: ${JSON.stringify(data)}`);
  }
}

// ============================================================
// CALENDAR HELPERS (for /stats)
// ============================================================

/** /stats entry point — opens the year+month picker (defaults to current year). */
async function sendStatsCalendar(chatId: number | string) {
  const year = new Date().getFullYear();
  // Send initial message — renderCalendarYear will be called via fresh sendMessage
  const salesByMonth = await getSalesByMonthForYear(year);
  const text = calendarYearText(year, salesByMonth);
  const keyboard = buildCalendarYearKeyboard(year, salesByMonth);
  await sendMessage(chatId, text, { reply_markup: keyboard });
}

/** Re-render the year+month picker (called when user taps ◀/▶ year buttons). */
async function renderCalendarYear(
  chatId: number | string,
  messageId: number | undefined,
  year: number
) {
  const salesByMonth = await getSalesByMonthForYear(year);
  const text = calendarYearText(year, salesByMonth);
  const keyboard = buildCalendarYearKeyboard(year, salesByMonth);
  if (messageId) {
    try {
      await editMessageText(chatId, messageId, text, keyboard);
    } catch {
      await sendMessage(chatId, text, { reply_markup: keyboard });
    }
  } else {
    await sendMessage(chatId, text, { reply_markup: keyboard });
  }
}

/** Render the day grid for a specific (year, month). */
async function renderCalendarMonth(
  chatId: number | string,
  messageId: number | undefined,
  year: number,
  month: number
) {
  const salesByDay = await getSalesByDayForMonth(year, month);
  const text = calendarMonthText(year, month, salesByDay);
  // PKT-aware weekday for day 1 (0=Monday) + days in month
  const startOffset = (firstWeekdayOfMonthPkt(year, month) + 6) % 7; // convert Sun=0 → Mon=0
  const dim = daysInMonthPkt(year, month);
  const keyboard = buildCalendarMonthKeyboard(year, month, salesByDay, startOffset, dim);
  if (messageId) {
    try {
      await editMessageText(chatId, messageId, text, keyboard);
    } catch {
      await sendMessage(chatId, text, { reply_markup: keyboard });
    }
  } else {
    await sendMessage(chatId, text, { reply_markup: keyboard });
  }
}

/** Render a specific day's full sales detail. */
async function renderCalendarDay(
  chatId: number | string,
  messageId: number | undefined,
  year: number,
  month: number,
  day: number
) {
  // PKT-aware date range: midnight PKT today → midnight PKT tomorrow
  const start = pktMidnightUtc(year, month, day);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const sales = await db.sale.findMany({
    where: { date: { gte: start, lt: end } },
    orderBy: { date: "asc" },
  });

  // Format the date label in PKT (Peshawar time)
  const dateLabel = start.toLocaleDateString("en-US", {
    timeZone: "Asia/Karachi",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const lines: string[] = [];
  lines.push(`📅 <b>DAY DETAILS</b>`);
  lines.push(`<b>${dateLabel}</b>`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  if (sales.length === 0) {
    lines.push("📭 No sales recorded on this day.");
  } else {
    const totalUnits = sales.reduce((s, x) => s + x.quantity, 0);
    const totalRevenue = sales.reduce((s, x) => s + x.revenue, 0);
    const totalProfit = sales.reduce((s, x) => s + x.profit, 0);
    const paidCount = sales.filter((s) => s.paymentStatus === "done").length;
    const avgPrice = Math.round(totalRevenue / totalUnits);

    lines.push(`📊 <b>DAY TOTALS</b>`);
    lines.push(`🧾 Sales: <b>${sales.length}</b>`);
    lines.push(`✅ Units: <b>${totalUnits}</b>`);
    lines.push(`💵 Revenue: <b>${formatPKR(totalRevenue)}</b>`);
    lines.push(`🎯 Profit: <b>${formatPKR(totalProfit)}</b>`);
    lines.push(`📊 Avg Price: <b>${formatPKR(avgPrice)}/unit</b>`);
    lines.push(`💰 Paid: <b>${paidCount}/${sales.length}</b>`);
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // Per-reseller breakdown for the day
    const byReseller = new Map<string, { units: number; revenue: number; profit: number; sales: number }>();
    for (const s of sales) {
      const cur = byReseller.get(s.resellerName) ?? { units: 0, revenue: 0, profit: 0, sales: 0 };
      cur.units += s.quantity;
      cur.revenue += s.revenue;
      cur.profit += s.profit;
      cur.sales += 1;
      byReseller.set(s.resellerName, cur);
    }
    lines.push(`👥 <b>BY RESELLER</b>`);
    for (const [name, v] of Array.from(byReseller.entries()).sort((a, b) => b[1].units - a[1].units)) {
      lines.push(`• ${escapeHtml(name)}: ${v.units} units · ${v.sales} sales · ${formatPKR(v.revenue)} rev · ${formatPKR(v.profit)} profit`);
    }
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // Individual sales list
    lines.push(`📋 <b>ALL SALES THIS DAY</b>`);
    sales.forEach((s, i) => {
      const d = new Date(s.date);
      const timeStr = d.toLocaleTimeString("en-US", { timeZone: "Asia/Karachi", hour: "numeric", minute: "2-digit" });
      lines.push(
        `<b>#${i + 1}</b> ${escapeHtml(s.resellerName)} · ${s.quantity}×${formatPKR(s.pricePerUnit)} = ${formatPKR(s.revenue)} (profit ${formatPKR(s.profit)}) · ${formatPayment(s.paymentStatus as PaymentStatus)} · ${timeStr}`
      );
    });
  }
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const keyboard = buildCalendarDayKeyboard(year, month);
  if (messageId) {
    try {
      await editMessageText(chatId, messageId, lines.join("\n"), keyboard);
    } catch {
      await sendMessage(chatId, lines.join("\n"), { reply_markup: keyboard });
    }
  } else {
    await sendMessage(chatId, lines.join("\n"), { reply_markup: keyboard });
  }
}

/** Build the monthly overview text (used by 📊 Monthly Overview button). */
async function buildMonthOverviewText(year: number, month: number): Promise<string> {
  const start = startOfMonthPkt(year, month);
  const end = endOfMonthPkt(year, month);

  const sales = await db.sale.findMany({
    where: { date: { gte: start, lt: end } },
    orderBy: { date: "asc" },
  });

  const monthName = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Karachi", month: "long", year: "numeric" }).format(new Date(Date.UTC(year, month - 1, 10)));

  if (sales.length === 0) {
    return `📭 <b>${monthName}</b>\n\nNo sales recorded this month.`;
  }

  const totalUnits = sales.reduce((s, x) => s + x.quantity, 0);
  const totalRevenue = sales.reduce((s, x) => s + x.revenue, 0);
  const totalProfit = sales.reduce((s, x) => s + x.profit, 0);
  const avgPrice = Math.round(totalRevenue / totalUnits);
  const paidCount = sales.filter((s) => s.paymentStatus === "done").length;
  const daysInMonth = new Date(year, month, 0).getDate();
  const daysWithSales = new Set(sales.map((s) => pktDateKey(s.date))).size;
  const onPace = daysWithSales > 0 ? Math.round((totalProfit / daysWithSales) * daysInMonth) : 0;

  // Per-reseller
  const byReseller = new Map<string, { units: number; revenue: number; profit: number; sales: number }>();
  for (const s of sales) {
    const cur = byReseller.get(s.resellerName) ?? { units: 0, revenue: 0, profit: 0, sales: 0 };
    cur.units += s.quantity;
    cur.revenue += s.revenue;
    cur.profit += s.profit;
    cur.sales += 1;
    byReseller.set(s.resellerName, cur);
  }

  // Best day
  const byDay = new Map<string, { units: number; revenue: number; profit: number }>();
  for (const s of sales) {
    const key = pktDateKey(s.date);
    const cur = byDay.get(key) ?? { units: 0, revenue: 0, profit: 0 };
    cur.units += s.quantity;
    cur.revenue += s.revenue;
    cur.profit += s.profit;
    byDay.set(key, cur);
  }
  const bestDay = Array.from(byDay.entries()).sort((a, b) => b[1].profit - a[1].profit)[0];

  const lines: string[] = [];
  lines.push(`📊 <b>MONTHLY OVERVIEW — ${monthName}</b>`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`📅 Days with sales: <b>${daysWithSales}/${daysInMonth}</b>`);
  lines.push(`🧾 Total sales: <b>${sales.length}</b>`);
  lines.push(`✅ Total Units: <b>${totalUnits}</b>`);
  lines.push(`💵 Total Revenue: <b>${formatPKR(totalRevenue)}</b>`);
  lines.push(`🎯 Total Profit: <b>${formatPKR(totalProfit)}</b>`);
  lines.push(`📊 Avg Price: <b>${formatPKR(avgPrice)}/unit</b>`);
  lines.push(`💰 Paid: <b>${paidCount}/${sales.length}</b>`);
  lines.push(`📈 Avg Profit/Day: <b>${formatPKR(Math.round(totalProfit / daysWithSales))}</b>`);
  lines.push(`🎯 On-pace for month: <b>${formatPKR(onPace)} profit</b>`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  if (bestDay) {
    lines.push(`💎 <b>BEST DAY</b>: ${bestDay[0]} (${bestDay[1].units} units, ${formatPKR(bestDay[1].profit)} profit)`);
  }
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`👥 <b>BY RESELLER</b>`);
  for (const [name, v] of Array.from(byReseller.entries()).sort((a, b) => b[1].units - a[1].units)) {
    lines.push(`• ${escapeHtml(name)}: ${v.units} units · ${v.sales} sales · ${formatPKR(v.revenue)} rev · ${formatPKR(v.profit)} profit`);
  }
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("👇 Tap ◀ Back to month to return to the day grid.");
  return lines.join("\n");
}

/** Build the weekly breakdown text (used by 📅 Weekly Breakdown button). */
async function buildWeeklyBreakdownText(year: number, month: number): Promise<string> {
  const start = startOfMonthPkt(year, month);
  const end = endOfMonthPkt(year, month);

  const sales = await db.sale.findMany({
    where: { date: { gte: start, lt: end } },
    orderBy: { date: "asc" },
  });

  const monthName = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Karachi", month: "long", year: "numeric" }).format(new Date(Date.UTC(year, month - 1, 10)));

  if (sales.length === 0) {
    return `📭 <b>${monthName}</b>\n\nNo sales recorded this month.`;
  }

  // Bucket sales by ISO week (Mon-Sun)
  // Week 1 starts on the first Monday of the month OR day 1 if month starts on Monday
  // Simpler: group by calendar week starting Monday — compute week index relative to month start
  const lines: string[] = [];
  lines.push(`📅 <b>WEEKLY BREAKDOWN — ${monthName}</b>`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // Build per-week buckets: each bucket = { startDate, endDate, units, revenue, profit, sales }
  type Week = { startDate: Date; endDate: Date; units: number; revenue: number; profit: number; sales: number };
  const weeks: Week[] = [];

  // Find first Monday of the month (or use day 1 if it's a Monday)
  const firstDayOfWeekPkt = firstWeekdayOfMonthPkt(year, month);
  const firstDayOfWeek = (firstDayOfWeekPkt + 6) % 7; // 0=Mon
  const firstMondayUtc = pktMidnightUtc(year, month, 1);
  // First Monday on/before day 1 of the month
  const firstMonday = new Date(firstMondayUtc.getTime() - firstDayOfWeek * 24 * 60 * 60 * 1000);

  // Iterate weeks until we're past month end (PKT)
  const monthEnd = endOfMonthPkt(year, month);
  const firstOfMonthPktDate = startOfMonthPkt(year, month);
  let cursor = new Date(firstMonday);
  let weekIdx = 0;
  while (cursor < monthEnd) {
    const weekStart = new Date(cursor);
    const weekEnd = new Date(cursor);
    weekEnd.setDate(weekEnd.getDate() + 7);
    weeks.push({
      startDate: weekStart,
      endDate: weekEnd,
      units: 0,
      revenue: 0,
      profit: 0,
      sales: 0,
    });
    cursor = new Date(weekEnd);
    weekIdx++;
    if (weekIdx > 10) break; // safety
  }

  // Bucket sales into weeks
  for (const s of sales) {
    for (const w of weeks) {
      if (s.date >= w.startDate && s.date < w.endDate) {
        w.units += s.quantity;
        w.revenue += s.revenue;
        w.profit += s.profit;
        w.sales += 1;
        break;
      }
    }
  }

  // Render each week, filtering to weeks that overlap the month
  let weekNum = 1;
  for (const w of weeks) {
    // Skip weeks that are entirely before or after the month
    if (w.endDate <= firstOfMonthPktDate || w.startDate >= monthEnd) continue;

    const startStr = w.startDate.toLocaleDateString("en-US", { timeZone: "Asia/Karachi", month: "short", day: "numeric" });
    const endStr = new Date(w.endDate.getTime() - 86400000).toLocaleDateString("en-US", { timeZone: "Asia/Karachi", month: "short", day: "numeric" });

    if (w.sales === 0) {
      lines.push(`<b>Week ${weekNum}</b> (${startStr} – ${endStr}): <i>no sales</i>`);
    } else {
      lines.push(`<b>Week ${weekNum}</b> (${startStr} – ${endStr})`);
      lines.push(`  ${w.sales} sales · ${w.units} units · ${formatPKR(w.revenue)} rev · ${formatPKR(w.profit)} profit`);
    }
    weekNum++;
  }
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  const totalUnits = sales.reduce((s, x) => s + x.quantity, 0);
  const totalRevenue = sales.reduce((s, x) => s + x.revenue, 0);
  const totalProfit = sales.reduce((s, x) => s + x.profit, 0);
  lines.push(`📊 <b>MONTH TOTAL</b>: ${sales.length} sales · ${totalUnits} units · ${formatPKR(totalRevenue)} rev · ${formatPKR(totalProfit)} profit`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("👇 Tap ◀ Back to month to return to the day grid.");
  return lines.join("\n");
}

/** Compute a Map<"YYYY-MM", saleCount> for the given year. */
async function getSalesByMonthForYear(year: number): Promise<Map<string, number>> {
  const start = new Date(year, 0, 1);
  const end = new Date(year + 1, 0, 1);
  const sales = await db.sale.findMany({
    where: { date: { gte: start, lt: end } },
    select: { date: true },
  });
  const m = new Map<string, number>();
  for (const s of sales) {
    const key = pktMonthKey(s.date); // YYYY-MM
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
}

/** Compute a Map<"YYYY-MM-DD", saleCount> for the given (year, month). */
async function getSalesByDayForMonth(year: number, month: number): Promise<Map<string, number>> {
  const start = startOfMonthPkt(year, month);
  const end = endOfMonthPkt(year, month);
  const sales = await db.sale.findMany({
    where: { date: { gte: start, lt: end } },
    select: { date: true },
  });
  const m = new Map<string, number>();
  for (const s of sales) {
    const key = pktDateKey(s.date); // YYYY-MM-DD
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
}

// ============================================================
// PAYMENT CALENDAR HELPERS (for /pay)
// ============================================================

/** /pay entry point — opens the payment year+month picker. */
async function sendPayCalendar(chatId: number | string) {
  const year = new Date().getFullYear();
  const paymentByMonth = await getPaymentByMonthForYear(year);
  const text = payCalendarYearText(year, paymentByMonth);
  const keyboard = buildPayCalendarYearKeyboard(year, paymentByMonth);
  await sendMessage(chatId, text, { reply_markup: keyboard });
}

/** Re-render the payment year+month picker. */
async function renderPayCalendarYear(
  chatId: number | string,
  messageId: number | undefined,
  year: number
) {
  const paymentByMonth = await getPaymentByMonthForYear(year);
  const text = payCalendarYearText(year, paymentByMonth);
  const keyboard = buildPayCalendarYearKeyboard(year, paymentByMonth);
  if (messageId) {
    try {
      await editMessageText(chatId, messageId, text, keyboard);
    } catch {
      await sendMessage(chatId, text, { reply_markup: keyboard });
    }
  } else {
    await sendMessage(chatId, text, { reply_markup: keyboard });
  }
}

/** Render the payment day grid for a (year, month). */
async function renderPayCalendarMonth(
  chatId: number | string,
  messageId: number | undefined,
  year: number,
  month: number
) {
  const paymentByDay = await getPaymentByDayForMonth(year, month);
  const text = payCalendarMonthText(year, month, paymentByDay);
  const startOffset = (firstWeekdayOfMonthPkt(year, month) + 6) % 7;
  const dim = daysInMonthPkt(year, month);
  const keyboard = buildPayCalendarMonthKeyboard(year, month, paymentByDay, startOffset, dim);
  if (messageId) {
    try {
      await editMessageText(chatId, messageId, text, keyboard);
    } catch {
      await sendMessage(chatId, text, { reply_markup: keyboard });
    }
  } else {
    await sendMessage(chatId, text, { reply_markup: keyboard });
  }
}

/** Render a specific day's payment detail (with toggle buttons). */
async function renderPayCalendarDay(
  chatId: number | string,
  messageId: number | undefined,
  year: number,
  month: number,
  day: number
) {
  // PKT-aware: midnight PKT today → midnight PKT tomorrow
  const start = pktMidnightUtc(year, month, day);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const sales = await db.sale.findMany({
    where: { date: { gte: start, lt: end } },
    orderBy: { date: "asc" },
  });

  const dateLabel = start.toLocaleDateString("en-US", {
    timeZone: "Asia/Karachi",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const saleRows: SaleRow[] = sales.map((s) => ({
    id: s.id,
    date: s.date.toISOString(),
    resellerName: s.resellerName,
    quantity: s.quantity,
    pricePerUnit: s.pricePerUnit,
    revenue: s.revenue,
    profit: s.profit,
    paymentStatus: s.paymentStatus as PaymentStatus,
  }));

  const lines: string[] = [];
  lines.push(`💳 <b>PAYMENTS — DAY DETAILS</b>`);
  lines.push(`<b>${dateLabel}</b>`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  if (sales.length === 0) {
    lines.push("📭 No sales recorded on this day.");
  } else {
    const paidCount = sales.filter((s) => s.paymentStatus === "done").length;
    const pendingCount = sales.length - paidCount;
    const paidRevenue = sales
      .filter((s) => s.paymentStatus === "done")
      .reduce((s, x) => s + x.revenue, 0);
    const pendingRevenue = sales
      .filter((s) => s.paymentStatus !== "done")
      .reduce((s, x) => s + x.revenue, 0);

    lines.push(`📊 <b>DAY TOTALS</b>`);
    lines.push(`🧾 Sales: <b>${sales.length}</b>`);
    lines.push(`💰 Paid: <b>${paidCount}</b> (${formatPKR(paidRevenue)})`);
    lines.push(`⏳ Pending: <b>${pendingCount}</b> (${formatPKR(pendingRevenue)})`);
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    lines.push(`👇 Tap a button below to flip a sale's payment status.`);
  }

  const keyboard = buildPayDayKeyboard(year, month, saleRows);
  if (messageId) {
    try {
      await editMessageText(chatId, messageId, lines.join("\n"), keyboard);
    } catch {
      await sendMessage(chatId, lines.join("\n"), { reply_markup: keyboard });
    }
  } else {
    await sendMessage(chatId, lines.join("\n"), { reply_markup: keyboard });
  }
}

/** Build the payment month overview text. */
async function buildPayMonthOverviewText(year: number, month: number): Promise<string> {
  const start = startOfMonthPkt(year, month);
  const end = endOfMonthPkt(year, month);

  const sales = await db.sale.findMany({
    where: { date: { gte: start, lt: end } },
    orderBy: { date: "asc" },
  });

  const monthName = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Karachi", month: "long", year: "numeric" }).format(new Date(Date.UTC(year, month - 1, 10)));

  if (sales.length === 0) {
    return `📭 <b>${monthName}</b>\n\nNo sales recorded this month.`;
  }

  const paidCount = sales.filter((s) => s.paymentStatus === "done").length;
  const pendingCount = sales.length - paidCount;
  const paidRevenue = sales
    .filter((s) => s.paymentStatus === "done")
    .reduce((s, x) => s + x.revenue, 0);
  const pendingRevenue = sales
    .filter((s) => s.paymentStatus !== "done")
    .reduce((s, x) => s + x.revenue, 0);
  const totalRevenue = paidRevenue + pendingRevenue;
  const collectionRate = totalRevenue > 0 ? Math.round((paidRevenue / totalRevenue) * 100) : 0;

  // Per-reseller payment breakdown
  const byReseller = new Map<string, { paid: number; pending: number; paidRev: number; pendingRev: number }>();
  for (const s of sales) {
    const cur = byReseller.get(s.resellerName) ?? { paid: 0, pending: 0, paidRev: 0, pendingRev: 0 };
    if (s.paymentStatus === "done") {
      cur.paid += 1;
      cur.paidRev += s.revenue;
    } else {
      cur.pending += 1;
      cur.pendingRev += s.revenue;
    }
    byReseller.set(s.resellerName, cur);
  }

  const lines: string[] = [];
  lines.push(`📊 <b>PAYMENT OVERVIEW — ${monthName}</b>`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`🧾 Total sales: <b>${sales.length}</b>`);
  lines.push(`💰 Paid: <b>${paidCount}</b> (${formatPKR(paidRevenue)})`);
  lines.push(`⏳ Pending: <b>${pendingCount}</b> (${formatPKR(pendingRevenue)})`);
  lines.push(`📈 Collection rate: <b>${collectionRate}%</b>`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`👥 <b>BY RESELLER</b>`);
  for (const [name, v] of Array.from(byReseller.entries()).sort((a, b) => (b[1].paid + b[1].pending) - (a[1].paid + a[1].pending))) {
    lines.push(`• ${escapeHtml(name)}: 💰${v.paid} (${formatPKR(v.paidRev)}) · ⏳${v.pending} (${formatPKR(v.pendingRev)})`);
  }
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("👇 Tap ◀ Back to month to return to the day grid.");
  return lines.join("\n");
}

/** Compute a Map<"YYYY-MM", { paid, pending }> for the given year. */
async function getPaymentByMonthForYear(year: number): Promise<Map<string, { paid: number; pending: number }>> {
  const start = new Date(year, 0, 1);
  const end = new Date(year + 1, 0, 1);
  const sales = await db.sale.findMany({
    where: { date: { gte: start, lt: end } },
    select: { date: true, paymentStatus: true },
  });
  const m = new Map<string, { paid: number; pending: number }>();
  for (const s of sales) {
    const key = pktMonthKey(s.date);
    const cur = m.get(key) ?? { paid: 0, pending: 0 };
    if (s.paymentStatus === "done") cur.paid += 1;
    else cur.pending += 1;
    m.set(key, cur);
  }
  return m;
}

/** Compute a Map<"YYYY-MM-DD", { paid, pending }> for the given (year, month). */
async function getPaymentByDayForMonth(year: number, month: number): Promise<Map<string, { paid: number; pending: number }>> {
  const start = startOfMonthPkt(year, month);
  const end = endOfMonthPkt(year, month);
  const sales = await db.sale.findMany({
    where: { date: { gte: start, lt: end } },
    select: { date: true, paymentStatus: true },
  });
  const m = new Map<string, { paid: number; pending: number }>();
  for (const s of sales) {
    const key = pktDateKey(s.date);
    const cur = m.get(key) ?? { paid: 0, pending: 0 };
    if (s.paymentStatus === "done") cur.paid += 1;
    else cur.pending += 1;
    m.set(key, cur);
  }
  return m;
}

// ============================================================
// SALES CALENDAR HELPERS (for /sale command — merged /pay flow)
// ============================================================

/** /sale entry point — opens the year+month picker (defaults to current year). */
async function sendSalesCalendar(chatId: number | string) {
  const year = pktParts().year;
  const salesByMonth = await getSalesByMonthForYear(year);
  const text = salesCalendarYearText(year, salesByMonth);
  const keyboard = buildSalesCalendarYearKeyboard(year, salesByMonth);
  await sendMessage(chatId, text, { reply_markup: keyboard });
}

/** Re-render the /sale year+month picker (called when user taps ◀/▶ year buttons). */
async function renderSalesCalendarYear(
  chatId: number | string,
  messageId: number | undefined,
  year: number
) {
  const salesByMonth = await getSalesByMonthForYear(year);
  const text = salesCalendarYearText(year, salesByMonth);
  const keyboard = buildSalesCalendarYearKeyboard(year, salesByMonth);
  if (messageId) {
    try {
      await editMessageText(chatId, messageId, text, keyboard);
    } catch {
      await sendMessage(chatId, text, { reply_markup: keyboard });
    }
  } else {
    await sendMessage(chatId, text, { reply_markup: keyboard });
  }
}

/** Render the /sale day grid for a specific (year, month). */
async function renderSalesCalendarMonth(
  chatId: number | string,
  messageId: number | undefined,
  year: number,
  month: number
) {
  const salesByDay = await getSalesByDayForMonth(year, month);
  const text = salesCalendarMonthText(year, month, salesByDay);
  const startOffset = (firstWeekdayOfMonthPkt(year, month) + 6) % 7;
  const dim = daysInMonthPkt(year, month);
  const keyboard = buildSalesCalendarMonthKeyboard(year, month, salesByDay, startOffset, dim);
  if (messageId) {
    try {
      await editMessageText(chatId, messageId, text, keyboard);
    } catch {
      await sendMessage(chatId, text, { reply_markup: keyboard });
    }
  } else {
    await sendMessage(chatId, text, { reply_markup: keyboard });
  }
}

/** Render the /sale day detail — totals + one button per sale. */
async function renderSalesCalendarDay(
  chatId: number | string,
  messageId: number | undefined,
  year: number,
  month: number,
  day: number
) {
  const start = pktMidnightUtc(year, month, day);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const sales = await db.sale.findMany({
    where: { date: { gte: start, lt: end } },
    orderBy: { date: "asc" },
  });

  const dateLabel = start.toLocaleDateString("en-US", {
    timeZone: "Asia/Karachi",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const saleRows: SaleRow[] = sales.map((s) => ({
    id: s.id,
    date: s.date.toISOString(),
    resellerName: s.resellerName,
    quantity: s.quantity,
    pricePerUnit: s.pricePerUnit,
    revenue: s.revenue,
    profit: s.profit,
    paymentStatus: s.paymentStatus as PaymentStatus,
    geminiLink: s.geminiLink ?? "",
  }));

  const text = salesDayText(dateLabel, saleRows);
  const keyboard = buildSalesDayKeyboard(year, month, saleRows, day);
  if (messageId) {
    try {
      await editMessageText(chatId, messageId, text, keyboard);
    } catch {
      await sendMessage(chatId, text, { reply_markup: keyboard });
    }
  } else {
    await sendMessage(chatId, text, { reply_markup: keyboard });
  }
}

/** Render the per-sale action menu (delete / edit link / toggle pay). */
async function renderSalesActionMenu(
  chatId: number | string,
  messageId: number | undefined,
  saleId: string
) {
  const sale = await db.sale.findUnique({ where: { id: saleId } });
  if (!sale) {
    if (messageId) {
      await editMessageText(chatId, messageId, "⚠️ Unit not found — it may have been deleted.\nSend /sale to start over.");
    } else {
      await sendMessage(chatId, "⚠️ Unit not found — it may have been deleted.\nSend /sale to start over.");
    }
    return;
  }
  const d = new Date(sale.date);
  const pkt = pktParts(d);
  const saleRow: SaleRow = {
    id: sale.id,
    date: sale.date.toISOString(),
    resellerName: sale.resellerName,
    quantity: sale.quantity,
    pricePerUnit: sale.pricePerUnit,
    revenue: sale.revenue,
    profit: sale.profit,
    paymentStatus: sale.paymentStatus as PaymentStatus,
    geminiLink: sale.geminiLink ?? "",
  };
  const text = salesActionText(saleRow);
  const keyboard = buildSalesActionKeyboard(pkt.year, pkt.month, sale.id);
  if (messageId) {
    try {
      await editMessageText(chatId, messageId, text, keyboard);
    } catch {
      await sendMessage(chatId, text, { reply_markup: keyboard });
    }
  } else {
    await sendMessage(chatId, text, { reply_markup: keyboard });
  }
}

/** /backup — manually create a named backup snapshot. */
async function manualBackup(chatId: number | string) {
  // Force a snapshot right now (bypass throttle)
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `/home/z/my-project/db/backups/manual-${ts}.db`;
  try {
    await fs.copyFile("/home/z/my-project/db/custom.db", dest);
    const backups = await listBackups();
    await sendMessage(
      chatId,
      `💾 <b>Manual backup created</b>\n\n` +
        `📁 File: <code>${dest.split("/").pop()}</code>\n` +
        `📊 Total backups: <b>${backups.length}</b>\n\n` +
        `Your data is safe. Backups never auto-delete.`
    );
  } catch (e) {
    await sendMessage(chatId, `❌ Backup failed: ${(e as Error).message}`);
  }
}

/** /restore — restore DB from the most recent backup file. */
async function manualRestore(chatId: number | string) {
  const backups = await listBackups();
  if (backups.length === 0) {
    await sendMessage(chatId, "⚠️ No backups available to restore from.");
    return;
  }

  // Safety: show what we're about to do and require confirmation
  const latest = backups[0];
  const latestDate = new Date(latest.mtime).toLocaleString();

  // Just do the restore (the restoreFromLatestBackup also creates a pre-restore snapshot)
  const restored = await restoreFromLatestBackup();
  if (restored) {
    await sendMessage(
      chatId,
      `♻️ <b>Database restored</b>\n\n` +
        `📁 Restored from: <code>${restored}</code>\n` +
        `🕐 Backup date: ${latestDate}\n\n` +
        `✅ Your previous DB was saved as a pre-restore snapshot.\n` +
        `📊 Dashboard will reflect restored data on next refresh (≤4s).`
    );
  } else {
    await sendMessage(chatId, "❌ Restore failed. Check server logs.");
  }
}

// ============================================================
// NEW COMMAND HELPERS (search, report, pending, milestone, margins, compare, resellers, revenue)
// ============================================================

/** Parse a free-text search query and return the matching sales.
 *  Handles: reseller name, price (e.g. "550"), date in many formats
 *  ("4 june 2026", "june 4", "2026-06-04", "june", "2026-06", "2026").
 */
async function sendSearchResults(chatId: number | string, query: string) {
  const all = await db.sale.findMany({ orderBy: { date: "desc" } });
  const q = query.trim();
  const qlower = q.toLowerCase();

  // Detect query type
  const isPureNumber = /^\s*\d+\s*$/.test(q);
  const asPrice = isPureNumber ? Number(q.replace(/[^\d]/g, "")) : 0;

  // Parse a date from natural language. Returns { type: 'day'|'month'|'year'|'none', key: string, label: string }
  const dateParse = parseNaturalDate(q);

  const matches = all.filter((s) => {
    // 1. Reseller name (case-insensitive substring)
    if (s.resellerName.toLowerCase().includes(qlower)) return true;
    // 2. Pure-number price match
    if (isPureNumber && s.pricePerUnit === asPrice) return true;
    // 3. Date match (PKT)
    if (dateParse.type !== "none") {
      const dayKey = pktDateKey(s.date);
      const monthKey = pktMonthKey(s.date);
      const yearKey = String(s.date.getFullYear()); // approx — PKT year handled below
      if (dateParse.type === "day" && dayKey === dateParse.key) return true;
      if (dateParse.type === "month" && monthKey === dateParse.key) return true;
      if (dateParse.type === "year") {
        // Use PKT year
        const pktY = Number(pktParts(s.date).year);
        if (String(pktY) === dateParse.key) return true;
      }
      void yearKey;
    }
    return false;
  });

  // Build a human-readable description of what we searched for
  let searchDesc = escapeHtml(q);
  if (isPureNumber) searchDesc = `price = ${asPrice} PKR`;
  else if (dateParse.type === "day") searchDesc = `date = ${dateParse.label}`;
  else if (dateParse.type === "month") searchDesc = `month = ${dateParse.label}`;
  else if (dateParse.type === "year") searchDesc = `year = ${dateParse.label}`;
  else searchDesc = `reseller containing "${escapeHtml(q)}"`;

  if (matches.length === 0) {
    await sendMessage(
      chatId,
      `🔍 <b>SEARCH</b> — ${searchDesc}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📭 No matches found.\n\n` +
        `Try:\n` +
        `• A reseller name: <code>Mehroz</code>\n` +
        `• A price: <code>550</code>\n` +
        `• A date: <code>4 june 2026</code> or <code>june 4</code>\n` +
        `• A month: <code>june</code> or <code>2026-06</code>`
    );
    return;
  }

  const totalUnits = matches.reduce((s, x) => s + x.quantity, 0);
  const totalRevenue = matches.reduce((s, x) => s + x.revenue, 0);
  const totalProfit = matches.reduce((s, x) => s + x.profit, 0);

  const lines: string[] = [];
  lines.push(`🔍 <b>SEARCH RESULTS</b>`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`🔎 Searched for: ${searchDesc}`);
  lines.push(`📊 Found <b>${matches.length}</b> sale(s)`);
  lines.push(`📦 ${totalUnits} units · 💰 ${formatPKR(totalRevenue)} rev · 🎯 ${formatPKR(totalProfit)} profit`);
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  matches.slice(0, 20).forEach((s, i) => {
    const d = new Date(s.date);
    const dateStr = d.toLocaleDateString("en-US", { timeZone: "Asia/Karachi", month: "short", day: "numeric" }) +
      " " + d.toLocaleTimeString("en-US", { timeZone: "Asia/Karachi", hour: "numeric", minute: "2-digit" });
    lines.push(
      `<b>#${i + 1}</b> ${escapeHtml(s.resellerName)} · ${s.quantity}×${formatPKR(s.pricePerUnit)} = ${formatPKR(s.revenue)} (profit ${formatPKR(s.profit)}) · ${formatPayment(s.paymentStatus as PaymentStatus)} · ${dateStr} PKT`
    );
  });
  if (matches.length > 20) {
    lines.push(`\n...and ${matches.length - 20} more. Use /export for the full list.`);
  }
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  await sendMessage(chatId, lines.join("\n"));
}

/** Parse a natural-language date string. Returns the type + PKT key + human label.
 *  Handles:
 *   "4 june 2026" / "june 4 2026" / "4 june" / "june 4"
 *   "june" / "june 2026"
 *   "2026-06-04" / "2026-06" / "2026"
 *   "today" / "yesterday"
 */
function parseNaturalDate(input: string): {
  type: "day" | "month" | "year" | "none";
  key: string;
  label: string;
} {
  const s = input.trim().toLowerCase();

  // ISO date: YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    return { type: "day", key: `${m[1]}-${m[2]}-${m[3]}`, label: `${m[1]}-${m[2]}-${m[3]}` };
  }
  // ISO month: YYYY-MM
  m = s.match(/^(\d{4})-(\d{2})$/);
  if (m) {
    return { type: "month", key: `${m[1]}-${m[2]}`, label: `${m[1]}-${m[2]}` };
  }
  // ISO year: YYYY
  m = s.match(/^(\d{4})$/);
  if (m) {
    return { type: "year", key: m[1], label: m[1] };
  }

  // "today" / "yesterday"
  if (s === "today") {
    return { type: "day", key: pktDateKey(new Date()), label: "today" };
  }
  if (s === "yesterday") {
    const y = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return { type: "day", key: pktDateKey(y), label: "yesterday" };
  }

  // Month names map
  const monthMap: Record<string, number> = {
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12,
  };

  const currentYear = pktParts().year;

  // Pattern: "<day> <month> <year>" e.g. "4 june 2026" or "4 june"
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)(?:\s+(\d{4}))?$/);
  if (m) {
    const day = Number(m[1]);
    const monthName = m[2];
    const year = m[3] ? Number(m[3]) : currentYear;
    const month = monthMap[monthName];
    if (month && day >= 1 && day <= 31) {
      const key = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      return { type: "day", key, label: `${day} ${monthName} ${year}` };
    }
  }

  // Pattern: "<month> <day> <year>" e.g. "june 4 2026" or "june 4"
  m = s.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?$/);
  if (m) {
    const monthName = m[1];
    const day = Number(m[2]);
    const year = m[3] ? Number(m[3]) : currentYear;
    const month = monthMap[monthName];
    if (month && day >= 1 && day <= 31) {
      const key = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      return { type: "day", key, label: `${day} ${monthName} ${year}` };
    }
  }

  // Pattern: "<month> <year>" e.g. "june 2026"
  m = s.match(/^([a-z]+)\s+(\d{4})$/);
  if (m) {
    const monthName = m[1];
    const year = Number(m[2]);
    const month = monthMap[monthName];
    if (month) {
      const key = `${year}-${String(month).padStart(2, "0")}`;
      return { type: "month", key, label: `${monthName} ${year}` };
    }
  }

  // Pattern: just a month name e.g. "june"
  if (monthMap[s]) {
    const month = monthMap[s];
    const key = `${currentYear}-${String(month).padStart(2, "0")}`;
    return { type: "month", key, label: `${s} ${currentYear}` };
  }

  return { type: "none", key: "", label: "" };
}

/** /report — generate 30-day CSV report (sent as a downloadable file). */
async function sendReport(chatId: number | string) {
  const start = startOfRollingWeekPkt();
  // Use last 30 days instead of 7
  const thirtyDaysAgo = new Date(start.getTime() - 23 * 24 * 60 * 60 * 1000);

  const sales = await db.sale.findMany({
    where: { date: { gte: thirtyDaysAgo } },
    orderBy: { date: "asc" },
  });

  if (sales.length === 0) {
    await sendMessage(chatId, "📭 No sales in the last 30 days to report on.");
    return;
  }

  const totalUnits = sales.reduce((s, x) => s + x.quantity, 0);
  const totalRevenue = sales.reduce((s, x) => s + x.revenue, 0);
  const totalProfit = sales.reduce((s, x) => s + x.profit, 0);
  const paidCount = sales.filter((s) => s.paymentStatus === "done").length;

  // Build CSV
  const header = "Date (PKT),Reseller,Quantity,Price Per Unit,Revenue,Profit,Payment Status\n";
  const rows = sales
    .map((s) => {
      const d = new Date(s.date);
      const pktStr = d.toLocaleString("en-US", { timeZone: "Asia/Karachi" });
      const escapedName = `"${s.resellerName.replace(/"/g, '""')}"`;
      return `${pktStr},${escapedName},${s.quantity},${s.pricePerUnit},${s.revenue},${s.profit},${s.paymentStatus}`;
    })
    .join("\n");

  // Summary footer in CSV
  const summary = `\n\n--- SUMMARY ---\nPeriod,Last 30 days (PKT)\nTotal Sales,${sales.length}\nTotal Units,${totalUnits}\nTotal Revenue,${totalRevenue} PKR\nTotal Profit,${totalProfit} PKR\nPaid Sales,${paidCount}/${sales.length}\nAvg Profit/Sale,${Math.round(totalProfit / sales.length)} PKR\n`;

  const csv = header + rows + summary;

  // Send via Telegram's sendDocument API
  const formData = new FormData();
  formData.append("chat_id", String(chatId));
  const blob = new Blob([csv], { type: "text/csv" });
  formData.append("document", blob, `gemini-30day-report-${pktDateKey(new Date())}.csv`);

  const res = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN || "8992554756:AAHIdtvD7caRbnO8ybQtJSJNTNuT1cXJIx8"}/sendDocument`,
    {
      method: "POST",
      body: formData,
    }
  );
  const data = await res.json();
  if (!data.ok) {
    await sendMessage(chatId, `❌ Report generation failed: ${JSON.stringify(data)}`);
  }
}

/** /pending — list all sales with processing payment status (all-time). */
async function sendPendingPayments(chatId: number | string) {
  const sales = await db.sale.findMany({
    where: { paymentStatus: "processing" },
    orderBy: { date: "desc" },
  });

  if (sales.length === 0) {
    await sendMessage(
      chatId,
      "✅ <b>PENDING PAYMENTS</b>\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🎉 No pending payments! All sales are paid."
    );
    return;
  }

  const totalRevenue = sales.reduce((s, x) => s + x.revenue, 0);
  const totalProfit = sales.reduce((s, x) => s + x.profit, 0);

  // Group by reseller
  const byReseller = new Map<string, { count: number; revenue: number; profit: number }>();
  for (const s of sales) {
    const cur = byReseller.get(s.resellerName) ?? { count: 0, revenue: 0, profit: 0 };
    cur.count += 1;
    cur.revenue += s.revenue;
    cur.profit += s.profit;
    byReseller.set(s.resellerName, cur);
  }

  const lines: string[] = [];
  lines.push("⏳ <b>PENDING PAYMENTS</b> (all-time)");
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`🧾 Pending sales: <b>${sales.length}</b>`);
  lines.push(`💰 Outstanding revenue: <b>${formatPKR(totalRevenue)}</b>`);
  lines.push(`🎯 Outstanding profit: <b>${formatPKR(totalProfit)}</b>`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`👥 <b>BY RESELLER</b>`);
  for (const [name, v] of Array.from(byReseller.entries()).sort((a, b) => b[1].revenue - a[1].revenue)) {
    lines.push(`• ${escapeHtml(name)}: ${v.count} sales · ${formatPKR(v.revenue)} outstanding`);
  }
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`📋 <b>ALL PENDING SALES</b>`);
  sales.slice(0, 20).forEach((s, i) => {
    const d = new Date(s.date);
    const dateStr = d.toLocaleDateString("en-US", { timeZone: "Asia/Karachi", month: "short", day: "numeric" }) +
      " " + d.toLocaleTimeString("en-US", { timeZone: "Asia/Karachi", hour: "numeric", minute: "2-digit" });
    lines.push(`<b>#${i + 1}</b> ${escapeHtml(s.resellerName)} · ${s.quantity}×${formatPKR(s.pricePerUnit)} = ${formatPKR(s.revenue)} · ${dateStr} PKT`);
  });
  if (sales.length > 20) {
    lines.push(`\n...and ${sales.length - 20} more.`);
  }
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("💡 Use /pay to toggle a sale's payment status.");

  await sendMessage(chatId, lines.join("\n"));
}

/** /milestone — show business milestones reached. */
async function sendMilestones(chatId: number | string) {
  const sales = await db.sale.findMany({ orderBy: { date: "asc" } });

  if (sales.length === 0) {
    await sendMessage(chatId, "📭 No sales recorded yet. Send /new to start your journey!");
    return;
  }

  const totalUnits = sales.reduce((s, x) => s + x.quantity, 0);
  const totalRevenue = sales.reduce((s, x) => s + x.revenue, 0);
  const totalProfit = sales.reduce((s, x) => s + x.profit, 0);
  const totalSales = sales.length;
  const distinctDays = new Set(sales.map((s) => pktDateKey(s.date))).size;
  const distinctResellers = new Set(sales.map((s) => s.resellerName)).size;

  // Milestone definitions: [threshold, label, emoji]
  const unitMilestones = [
    [10, "First 10 units sold", "🥉"],
    [50, "50 units sold", "🥈"],
    [100, "100 units sold 🎉", "🥇"],
    [500, "500 units sold 🚀", "💎"],
    [1000, "1000 units sold 👑", "🏆"],
  ];
  const profitMilestones = [
    [1000, "1,000 PKR profit", "🥉"],
    [5000, "5,000 PKR profit", "🥈"],
    [10000, "10,000 PKR profit 🎉", "🥇"],
    [50000, "50,000 PKR profit 💎", "💎"],
    [100000, "100,000 PKR profit 👑", "🏆"],
  ];
  const dayMilestones = [
    [1, "First day selling", "🥉"],
    [7, "7-day streak", "🥈"],
    [30, "30-day streak 🎉", "🥇"],
    [100, "100-day streak 💎", "💎"],
  ];

  const lines: string[] = [];
  lines.push("🏆 <b>BUSINESS MILESTONES</b>");
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`📊 Current totals: ${totalSales} sales · ${totalUnits} units · ${formatPKR(totalRevenue)} rev · ${formatPKR(totalProfit)} profit`);
  lines.push(`📅 Active days: ${distinctDays} · 👥 Resellers: ${distinctResellers}`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  lines.push(`📦 <b>UNITS MILESTONES</b>`);
  for (const [t, label, emoji] of unitMilestones) {
    const reached = totalUnits >= t;
    lines.push(`${reached ? "✅" : "⬜"} ${emoji} ${label} ${reached ? "" : `(${totalUnits}/${t})`}`);
  }

  lines.push("");
  lines.push(`💰 <b>PROFIT MILESTONES</b>`);
  for (const [t, label, emoji] of profitMilestones) {
    const reached = totalProfit >= t;
    lines.push(`${reached ? "✅" : "⬜"} ${emoji} ${label} ${reached ? "" : `(${formatPKR(totalProfit)}/${formatPKR(t)})`}`);
  }

  lines.push("");
  lines.push(`📅 <b>STREAK MILESTONES</b>`);
  for (const [t, label, emoji] of dayMilestones) {
    const reached = distinctDays >= t;
    lines.push(`${reached ? "✅" : "⬜"} ${emoji} ${label} ${reached ? "" : `(${distinctDays}/${t})`}`);
  }

  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("Keep logging sales to unlock more milestones! 🚀");

  await sendMessage(chatId, lines.join("\n"));
}

/** /margins — profit margin analysis by price point. */
async function sendMargins(chatId: number | string) {
  const sales = await db.sale.findMany({ orderBy: { date: "desc" } });

  if (sales.length === 0) {
    await sendMessage(chatId, "📭 No sales recorded yet.");
    return;
  }

  // Group by price point
  const byPrice = new Map<number, { count: number; units: number; revenue: number; profit: number }>();
  for (const s of sales) {
    const cur = byPrice.get(s.pricePerUnit) ?? { count: 0, units: 0, revenue: 0, profit: 0 };
    cur.count += 1;
    cur.units += s.quantity;
    cur.revenue += s.revenue;
    cur.profit += s.profit;
    byPrice.set(s.pricePerUnit, cur);
  }

  const sorted = Array.from(byPrice.entries()).sort((a, b) => b[1].profit - a[1].profit);

  const lines: string[] = [];
  lines.push("📈 <b>PROFIT MARGIN ANALYSIS</b>");
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("Price · Cost · Margin/unit · Units · Total Profit");
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  for (const [price, v] of sorted) {
    const cost = COST_PER_UNIT;
    const marginPerUnit = price - cost;
    const marginPct = Math.round((marginPerUnit / price) * 100);
    const lines_count = v.count;
    lines.push(
      `<b>${formatPKR(price)}</b> · ${formatPKR(cost)} · <b>${formatPKR(marginPerUnit)}</b> (${marginPct}%) · ${v.units}u · ${formatPKR(v.profit)} (${lines_count} sales)`
    );
  }
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // Best price point
  const bestByProfit = sorted[0];
  const bestByMargin = Array.from(byPrice.entries()).sort(
    (a, b) => (b[0] - COST_PER_UNIT) - (a[0] - COST_PER_UNIT)
  )[0];

  lines.push(`💎 <b>BEST BY TOTAL PROFIT</b>: ${formatPKR(bestByProfit[0])}/unit → ${formatPKR(bestByProfit[1].profit)}`);
  lines.push(`🎯 <b>BEST MARGIN %</b>: ${formatPKR(bestByMargin[0])}/unit → ${Math.round(((bestByMargin[0] - COST_PER_UNIT) / bestByMargin[0]) * 100)}% margin`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("💡 Push higher-margin prices to maximize profit per unit.");

  await sendMessage(chatId, lines.join("\n"));
}

/** Parse a single period token (one half of an "X vs Y" comparison) into a date range.
 *  Accepts:
 *    - "today", "yesterday", "this week", "last week", "this month", "last month",
 *      "this year", "last year", "all"
 *    - "June", "July", "June 2026", "june"
 *    - "June 1st week", "June 2nd week", "June 3rd week", "June 4th week", "June 5th week"
 *    - "June 1st week 2026" etc.
 *
 *  All ranges are PKT-aligned.
 */
function parsePeriod(period: string): { start: Date; end: Date; label: string } | null {
  const p = period.trim().toLowerCase().replace(/[_\s]+/g, " ");

  // Keyword periods
  switch (p) {
    case "today":
      return { start: startOfTodayPkt(), end: endOfTodayPkt(), label: "today" };
    case "yesterday": {
      const start = new Date(startOfTodayPkt().getTime() - 24 * 60 * 60 * 1000);
      const end = startOfTodayPkt();
      return { start, end, label: "yesterday" };
    }
    case "this week":
    case "thisweek":
      return { start: startOfRollingWeekPkt(), end: new Date(), label: "this week (7d)" };
    case "last week":
    case "lastweek": {
      const end = startOfRollingWeekPkt();
      const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
      return { start, end, label: "last week" };
    }
    case "this month":
    case "thismonth":
      return { start: startOfMonthPkt(), end: endOfMonthPkt(), label: "this month" };
    case "last month":
    case "lastmonth": {
      const thisStart = startOfMonthPkt();
      // Last month PKT-aligned
      const p1 = pktParts(thisStart);
      const start = pktMidnightUtc(p1.year, p1.month, 1);
      const realStart = new Date(start.getTime());
      realStart.setUTCMonth(realStart.getUTCMonth() - 1);
      return { start: realStart, end: thisStart, label: "last month" };
    }
    case "this year":
    case "thisyear":
      return { start: startOfYearPkt(), end: endOfYearPkt(), label: "this year" };
    case "last year":
    case "lastyear": {
      const thisStart = startOfYearPkt();
      const start = new Date(thisStart.getTime());
      start.setUTCFullYear(start.getUTCFullYear() - 1);
      const end = thisStart;
      return { start, end, label: "last year" };
    }
    case "all":
    case "all time":
    case "alltime":
      return { start: new Date(0), end: new Date(), label: "all-time" };
  }

  // Month name lookup
  const monthMap: Record<string, number> = {
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12,
  };
  const currentYear = pktParts().year;

  // Pattern: "<month> <Nth> week <year>" e.g. "june 2nd week 2026"
  let m = p.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s*week(?:\s+(\d{4}))?$/);
  if (m) {
    const monthName = m[1];
    const weekNum = Number(m[2]);
    const year = m[3] ? Number(m[3]) : currentYear;
    const month = monthMap[monthName];
    if (month && weekNum >= 1 && weekNum <= 5) {
      // Week 1 = days 1-7, Week 2 = days 8-14, etc.
      const startDay = (weekNum - 1) * 7 + 1;
      const endDay = Math.min(weekNum * 7, new Date(Date.UTC(year, month, 0)).getUTCDate());
      const start = pktMidnightUtc(year, month, startDay);
      const end = pktMidnightUtc(year, month, endDay + 1);
      return {
        start,
        end,
        label: `${monthName} ${weekNum}${ordinalSuffix(weekNum)} week ${year}`,
      };
    }
  }

  // Pattern: "<month> <year>" e.g. "june 2026"
  m = p.match(/^([a-z]+)\s+(\d{4})$/);
  if (m) {
    const monthName = m[1];
    const year = Number(m[2]);
    const month = monthMap[monthName];
    if (month) {
      const start = pktMidnightUtc(year, month, 1);
      const end = new Date(start);
      end.setUTCMonth(end.getUTCMonth() + 1);
      return { start, end, label: `${monthName} ${year}` };
    }
  }

  // Pattern: just a month name e.g. "june"
  if (monthMap[p]) {
    const month = monthMap[p];
    const year = currentYear;
    const start = pktMidnightUtc(year, month, 1);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    return { start, end, label: `${p} ${year}` };
  }

  return null;
}

/** Returns "st", "nd", "rd", or "th" for the given integer. */
function ordinalSuffix(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

/**
 * /compare — compare two periods side by side.
 * Accepts a single free-text input like:
 *   "June vs July"
 *   "June 2nd week vs July 2nd week"
 *   "June 3rd week vs June 4th week"
 *   "This week vs last week"
 *   "Today vs yesterday"
 *
 * Splits on " vs " (case-insensitive) and parses each side with parsePeriod.
 */
async function sendCompare(chatId: number | string, input: string) {
  // Split on " vs " (case-insensitive). Also handle "vs" without spaces, "versus".
  const parts = input
    .split(/\s+(?:vs\.?|versus)\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length < 2) {
    await sendMessage(
      chatId,
      "⚠️ Could not find two periods to compare.\n\n" +
        "Please use the format: <code>X vs Y</code>\n\n" +
        "Examples:\n" +
        "• <code>June vs July</code>\n" +
        "• <code>June 2nd week vs July 2nd week</code>\n" +
        "• <code>June 3rd week vs June 4th week</code>\n" +
        "• <code>This week vs last week</code>\n" +
        "• <code>Today vs yesterday</code>"
    );
    return;
  }

  const period1 = parsePeriod(parts[0]);
  const period2 = parsePeriod(parts[1]);

  if (!period1) {
    await sendMessage(
      chatId,
      `⚠️ Could not understand the first period: <code>${escapeHtml(parts[0])}</code>\n\n` +
        "Try:\n" +
        "• <code>June</code> or <code>July</code> (a month)\n" +
        "• <code>June 2nd week</code> (a specific week of a month)\n" +
        "• <code>This week</code> / <code>Last week</code> / <code>This month</code> / <code>Last month</code>\n" +
        "• <code>Today</code> / <code>Yesterday</code>"
    );
    return;
  }
  if (!period2) {
    await sendMessage(
      chatId,
      `⚠️ Could not understand the second period: <code>${escapeHtml(parts[1])}</code>\n\n` +
        "Try:\n" +
        "• <code>June</code> or <code>July</code> (a month)\n" +
        "• <code>June 2nd week</code> (a specific week of a month)\n" +
        "• <code>This week</code> / <code>Last week</code> / <code>This month</code> / <code>Last month</code>\n" +
        "• <code>Today</code> / <code>Yesterday</code>"
    );
    return;
  }

  const [sales1, sales2] = await Promise.all([
    db.sale.findMany({ where: { date: { gte: period1.start, lt: period1.end } } }),
    db.sale.findMany({ where: { date: { gte: period2.start, lt: period2.end } } }),
  ]);

  const stats1 = {
    sales: sales1.length,
    units: sales1.reduce((s, x) => s + x.quantity, 0),
    revenue: sales1.reduce((s, x) => s + x.revenue, 0),
    profit: sales1.reduce((s, x) => s + x.profit, 0),
  };
  const stats2 = {
    sales: sales2.length,
    units: sales2.reduce((s, x) => s + x.quantity, 0),
    revenue: sales2.reduce((s, x) => s + x.revenue, 0),
    profit: sales2.reduce((s, x) => s + x.profit, 0),
  };

  function delta(a: number, b: number): string {
    if (b === 0) return a > 0 ? "🆕" : "—";
    const pct = Math.round(((a - b) / b) * 100);
    const sign = pct >= 0 ? "📈" : "📉";
    return `${sign} ${pct >= 0 ? "+" : ""}${pct}%`;
  }

  const lines: string[] = [];
  lines.push("📊 <b>PERIOD COMPARISON</b>");
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`                  <b>${escapeHtml(period1.label)}</b>`);
  lines.push(`                     vs`);
  lines.push(`                  <b>${escapeHtml(period2.label)}</b>`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`🧾 Sales:     ${String(stats1.sales).padStart(6)}  vs  ${String(stats2.sales).padStart(6)}   ${delta(stats1.sales, stats2.sales)}`);
  lines.push(`📦 Units:     ${String(stats1.units).padStart(6)}  vs  ${String(stats2.units).padStart(6)}   ${delta(stats1.units, stats2.units)}`);
  lines.push(`💰 Revenue:   ${formatPKR(stats1.revenue).padStart(10)}  vs  ${formatPKR(stats2.revenue).padStart(10)}   ${delta(stats1.revenue, stats2.revenue)}`);
  lines.push(`🎯 Profit:    ${formatPKR(stats1.profit).padStart(10)}  vs  ${formatPKR(stats2.profit).padStart(10)}   ${delta(stats1.profit, stats2.profit)}`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("📈 = growth · 📉 = decline · 🆕 = new (was 0)");

  await sendMessage(chatId, lines.join("\n"));
}

/** /resellers — list all resellers with tap-to-view buttons. */
async function sendResellersList(chatId: number | string) {
  const sales = await db.sale.findMany();
  if (sales.length === 0) {
    await sendMessage(chatId, "📭 No resellers yet. Send /new to log your first sale.");
    return;
  }

  const byReseller = new Map<string, { units: number; revenue: number; profit: number; sales: number; lastSale: Date }>();
  for (const s of sales) {
    const cur = byReseller.get(s.resellerName) ?? { units: 0, revenue: 0, profit: 0, sales: 0, lastSale: new Date(0) };
    cur.units += s.quantity;
    cur.revenue += s.revenue;
    cur.profit += s.profit;
    cur.sales += 1;
    if (s.date > cur.lastSale) cur.lastSale = s.date;
    byReseller.set(s.resellerName, cur);
  }

  const sorted = Array.from(byReseller.entries()).sort((a, b) => b[1].units - a[1].units);

  const lines: string[] = [];
  lines.push("👥 <b>ALL RESELLERS</b>");
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`📊 ${sorted.length} reseller(s) total`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  sorted.forEach(([name, v], i) => {
    const last = v.lastSale.toLocaleDateString("en-US", { timeZone: "Asia/Karachi", month: "short", day: "numeric" });
    lines.push(
      `<b>#${i + 1}</b> ${escapeHtml(name)}\n    ${v.units}u · ${v.sales} sales · ${formatPKR(v.revenue)} rev · ${formatPKR(v.profit)} profit · last: ${last}`
    );
  });
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("👇 Tap a button below to view that reseller's full history.");

  // Build inline keyboard with one button per reseller
  const keyboard = {
    inline_keyboard: [
      ...sorted.map(([name], i) => [
        { text: `#${i + 1} ${name}`, callback_data: `resview_${name}` },
      ]),
      [{ text: "❌ Close", callback_data: "cal_close" }],
    ],
  };

  await sendMessage(chatId, lines.join("\n"), { reply_markup: keyboard });
}

/** /revenue <period> — cash flow: collected vs outstanding. */
async function sendRevenueReport(chatId: number | string, period: string) {
  const p = parsePeriod(period);
  if (!p) {
    await sendMessage(
      chatId,
      "⚠️ Invalid period. Use:\n" +
        "• <code>today</code> · <code>yesterday</code>\n" +
        "• <code>this week</code> · <code>last week</code>\n" +
        "• <code>this month</code> · <code>last month</code>\n" +
        "• <code>this year</code> · <code>last year</code>\n" +
        "• A month name: <code>june</code> or <code>june 2026</code>\n" +
        "• <code>all</code>\n\n" +
        "Example: <code>/revenue this month</code>"
    );
    return;
  }

  const sales = await db.sale.findMany({
    where: { date: { gte: p.start, lt: p.end } },
    orderBy: { date: "asc" },
  });

  if (sales.length === 0) {
    await sendMessage(chatId, `📭 No sales in <b>${escapeHtml(p.label)}</b>.`);
    return;
  }

  const paid = sales.filter((s) => s.paymentStatus === "done");
  const pending = sales.filter((s) => s.paymentStatus !== "done");

  const paidRevenue = paid.reduce((s, x) => s + x.revenue, 0);
  const pendingRevenue = pending.reduce((s, x) => s + x.revenue, 0);
  const totalRevenue = paidRevenue + pendingRevenue;
  const collectionRate = totalRevenue > 0 ? Math.round((paidRevenue / totalRevenue) * 100) : 0;

  // Daily collection trend (last 7 days within the period)
  const byDay = new Map<string, { paid: number; pending: number }>();
  for (const s of sales) {
    const key = pktDateKey(s.date);
    const cur = byDay.get(key) ?? { paid: 0, pending: 0 };
    if (s.paymentStatus === "done") cur.paid += s.revenue;
    else cur.pending += s.revenue;
    byDay.set(key, cur);
  }
  const dailyTrend = Array.from(byDay.entries()).sort().slice(-7);

  const lines: string[] = [];
  lines.push(`💰 <b>REVENUE REPORT</b> — ${escapeHtml(p.label)}`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`🧾 Total sales: <b>${sales.length}</b>`);
  lines.push(`💵 Total revenue: <b>${formatPKR(totalRevenue)}</b>`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`✅ <b>COLLECTED</b>`);
  lines.push(`   ${paid.length} sales · <b>${formatPKR(paidRevenue)}</b>`);
  lines.push(`⏳ <b>OUTSTANDING</b>`);
  lines.push(`   ${pending.length} sales · <b>${formatPKR(pendingRevenue)}</b>`);
  lines.push(`📈 <b>COLLECTION RATE</b>: <b>${collectionRate}%</b>`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  if (dailyTrend.length > 0) {
    lines.push(`📅 <b>LAST 7 DAYS (within period)</b>`);
    for (const [day, v] of dailyTrend) {
      const total = v.paid + v.pending;
      const dayRate = total > 0 ? Math.round((v.paid / total) * 100) : 0;
      lines.push(`• ${day}: ${formatPKR(v.paid)}/${formatPKR(total)} (${dayRate}%)`);
    }
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  }

  lines.push("💡 Use /pending to see the full list of outstanding sales.");

  await sendMessage(chatId, lines.join("\n"));
}

// ============================================================
// SETTINGS MENU (for /settings)
// ============================================================

/**
 * Build the inline keyboard for the /settings menu. Every setting from
 * SETTING_DEFS gets its own button:
 *
 *   • Boolean settings → toggle button (callback `sett_<key>`) showing the
 *     current ON/OFF state with ✅/❌.
 *   • All other settings → edit-prompt button (callback `sete_<key>`) showing
 *     a short label. The current value is in the message text, not the button.
 *
 * The last row has a single "Close" button (callback `setc`).
 */
function buildSettingsKeyboard(currentValues: Record<string, string>) {
  const rows: { text: string; callback_data: string }[][] = [];
  for (const def of SETTING_DEFS) {
    const value = currentValues[def.key] ?? "";
    if (def.type === "boolean") {
      const isOn = value === "true";
      rows.push([
        {
          text: `${isOn ? "✅" : "❌"} ${def.label}: ${isOn ? "ON" : "OFF"}`,
          callback_data: `sett_${def.key}`,
        },
      ]);
    } else {
      const display = def.type === "password"
        ? (value ? "•••••••" : "(not set)")
        : (value.length > 30 ? value.slice(0, 27) + "…" : value);
      rows.push([
        {
          text: `✏️ ${def.label}: ${display}`,
          callback_data: `sete_${def.key}`,
        },
      ]);
    }
  }
  rows.push([{ text: "❌ Close", callback_data: "setc" }]);
  return { inline_keyboard: rows };
}

/**
 * Build the body text of the /settings menu. Lists every setting with its
 * current value (passwords are masked).
 */
function settingsMenuText(currentValues: Record<string, string>): string {
  const lines: string[] = [];
  lines.push("⚙️ <b>SETTINGS</b>");
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  for (const def of SETTING_DEFS) {
    const value = currentValues[def.key] ?? "";
    const display = def.type === "password"
      ? (value ? "•••••••" : "<i>(not set)</i>")
      : escapeHtml(value);
    lines.push(`<b>${escapeHtml(def.label)}</b>  <i>[${def.type}]</i>`);
    lines.push(`   ${display}`);
  }
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("👇 Tap a setting to edit it. Boolean toggles flip instantly.");
  return lines.join("\n");
}

/**
 * Render (or send) the /settings menu. If `messageId` is provided, the
 * existing message is edited in place; otherwise a new message is sent.
 */
async function sendSettingsMenu(
  chatId: number | string,
  fromId: number,
  messageId?: number
) {
  const typed = await getTypedSettings();
  const currentValues: Record<string, string> = {
    costPerUnit: String(typed.costPerUnit),
    allowedPrices: typed.allowedPrices.join(","),
    knownResellers: typed.knownResellers.join(","),
    adminPassword: typed.adminPassword,
    autoReminderEnabled: typed.autoReminderEnabled ? "true" : "false",
    autoReminderTime: typed.autoReminderTime,
    autoReminderLastSent: typed.autoReminderLastSent,
    botName: typed.botName,
    welcomeMessage: typed.welcomeMessage,
    dailyAutoPushEnabled: typed.dailyAutoPushEnabled ? "true" : "false",
    dailyAutoPushTime: typed.dailyAutoPushTime,
    currency: typed.currency,
    timezone: typed.timezone,
    refreshInterval: String(typed.refreshInterval),
  };
  const text = settingsMenuText(currentValues);
  const keyboard = buildSettingsKeyboard(currentValues);
  if (messageId) {
    try {
      await editMessageText(chatId, messageId, text, keyboard);
    } catch {
      await sendMessage(chatId, text, { reply_markup: keyboard });
    }
  } else {
    await sendMessage(chatId, text, { reply_markup: keyboard });
  }
}

// ============================================================
// ADMIN PANEL (for /admin)
// ============================================================

/**
 * Build the admin panel keyboard. 8 action buttons across 2 rows + a Close.
 *
 *   Settings   Stats        Resellers   Payments
 *   Backup     Restore      Wipe        Close
 */
function buildAdminPanelKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "⚙️ Settings", callback_data: "asettings" },
        { text: "📊 Stats", callback_data: "astats" },
        { text: "👥 Resellers", callback_data: "aresellers" },
        { text: "💳 Payments", callback_data: "apayments" },
      ],
      [
        { text: "💾 Backup", callback_data: "abackup" },
        { text: "♻️ Restore", callback_data: "arestore" },
        { text: "🗑 Wipe", callback_data: "awipe" },
        { text: "❌ Close", callback_data: "aclose" },
      ],
    ],
  };
}

/**
 * Render (or send) the admin panel. If `messageId` is provided, the existing
 * message is edited in place; otherwise a new message is sent.
 *
 * The panel includes a short system snapshot (total sales, units, revenue,
 * profit, paid/pending counts, # resellers, # distinct days) so the admin
 * gets a useful overview without having to tap a button.
 */
async function sendAdminPanel(
  chatId: number | string,
  messageId?: number
) {
  // Pull a quick all-time snapshot for the panel header.
  const sales = await db.sale.findMany();
  const totalUnits = sales.reduce((s, x) => s + x.quantity, 0);
  const totalRevenue = sales.reduce((s, x) => s + x.revenue, 0);
  const totalProfit = sales.reduce((s, x) => s + x.profit, 0);
  const paidCount = sales.filter((s) => s.paymentStatus === "done").length;
  const pendingCount = sales.length - paidCount;
  const resellerCount = new Set(sales.map((s) => s.resellerName)).size;
  const dayCount = new Set(sales.map((s) => pktDateKey(s.date))).size;

  const lines: string[] = [];
  lines.push("🔐 <b>ADMIN PANEL</b>");
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`🧾 Total sales: <b>${sales.length}</b>`);
  lines.push(`📦 Total units: <b>${totalUnits}</b>`);
  lines.push(`💰 Revenue: <b>${formatPKR(totalRevenue)}</b>`);
  lines.push(`🎯 Profit: <b>${formatPKR(totalProfit)}</b>`);
  lines.push(`✅ Paid: <b>${paidCount}</b> · ⏳ Pending: <b>${pendingCount}</b>`);
  lines.push(`👥 Resellers: <b>${resellerCount}</b> · 📅 Days active: <b>${dayCount}</b>`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("👇 Tap a button below to perform an admin action.");
  lines.push("⚠️ <b>Wipe</b> deletes ALL sales — use with caution.");

  const keyboard = buildAdminPanelKeyboard();
  if (messageId) {
    try {
      await editMessageText(chatId, messageId, lines.join("\n"), keyboard);
    } catch {
      await sendMessage(chatId, lines.join("\n"), { reply_markup: keyboard });
    }
  } else {
    await sendMessage(chatId, lines.join("\n"), { reply_markup: keyboard });
  }
}

/**
 * Admin "Wipe" — delete ALL sales from the database.
 * Creates a backup snapshot first so the operation can be undone via /restore.
 */
async function adminWipeAllSales(chatId: number | string) {
  const count = await db.sale.count();
  if (count === 0) {
    await sendMessage(chatId, "📭 Database is already empty — nothing to wipe.");
    return;
  }
  // Safety: snapshot the current DB before wiping so the user can /restore.
  void backupAfterEdit();
  await db.sale.deleteMany({});
  void backupAfterEdit();
  await sendMessage(
    chatId,
    `🗑 <b>WIPE COMPLETE</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `Deleted <b>${count}</b> sale(s) from the database.\n\n` +
      `💾 A pre-wipe backup snapshot was saved.\n` +
      `Use /restore to roll back if this was a mistake.`
  );
}

/** Send the welcome message that lists all commands. Shown on /start and any unknown text. */
export async function sendWelcome(chatId: number | string) {
  const text = [
    "💎 <b>GEMINI SALES BOT</b>",
    "<i>Reseller Business Tracker · PKT</i>",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    "<b>🔥 DAILY — Use these every day</b>",
    "  /new — Log a new unit",
    "  /daily — Today's stats",
    "  /sale — 📅 Calendar — manage units (delete/edit/pay)",
    "  /saledit — Alias for /sale (Units Manager calendar)",
    "",
    "<b>📊 STATS — View performance</b>",
    "  /stats — 📅 Calendar — pick any month/day",
    "  /weekly — Last 7 days summary",
    "  /month — Current month stats",
    "  /compare — Compare two periods (e.g. this_week vs last_week)",
    "  /revenue — Cash flow: collected vs outstanding",
    "  /margins — Profit margin analysis by price point",
    "  /milestone — Business milestones reached",
    "",
    "<b>👥 RESELLERS — Customer insights</b>",
    "  /resellers — List all resellers (tap to view)",
    "  /top — Top resellers leaderboard",
    "  /reseller &lt;name&gt; — One reseller's history + .txt reports",
    "  /pending — All pending payments (all-time)",
    "",
    "<b>🛠️ MANAGE — Tools</b>",
    "  /search &lt;query&gt; — Search units (name/price/date)",
    "  /undo — Delete your most recent unit",
    "  /export — Download all units as CSV",
    "  /report — 30-day CSV report (downloadable)",
    "",
    "<b>⚙️ CONFIGURATION — Owner/admin only</b>",
    "  /settings — View & edit bot settings (cost, prices, reminders, etc.)",
    "  /admin — Admin panel (stats, backup, restore, wipe)",
    "",
    "<b>🔐 DATA SAFETY — Backup &amp; help</b>",
    "  /backup — Snapshot the database now",
    "  /restore — Restore from latest backup",
    "  /help — Show this menu again",
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "🔒 Data is safe — auto-backed-up on every unit, never auto-deleted.",
    "🕐 All times in PKT (Peshawar, UTC+5).",
  ].join("\n");
  await sendMessage(chatId, text);
}

export async function sendTodaySummary(chatId: number | string) {
  const start = startOfTodayPkt();
  const end = endOfTodayPkt();

  const sales = await db.sale.findMany({
    where: { date: { gte: start, lt: end } },
    orderBy: { date: "desc" },
  });

  if (sales.length === 0) {
    await sendMessage(
      chatId,
      `📭 <b>No sales recorded today yet.</b>\n\nSend /new to log your first sale of the day.`
    );
    return;
  }

  const totalUnits = sales.reduce((s, x) => s + x.quantity, 0);
  const totalRevenue = sales.reduce((s, x) => s + x.revenue, 0);
  const totalProfit = sales.reduce((s, x) => s + x.profit, 0);
  const avgPrice = Math.round(totalRevenue / totalUnits);

  const byReseller = new Map<
    string,
    { units: number; revenue: number; profit: number; price: number }
  >();
  for (const s of sales) {
    const cur = byReseller.get(s.resellerName) ?? {
      units: 0,
      revenue: 0,
      profit: 0,
      price: s.pricePerUnit,
    };
    cur.units += s.quantity;
    cur.revenue += s.revenue;
    cur.profit += s.profit;
    byReseller.set(s.resellerName, cur);
  }

  const breakdown = Array.from(byReseller.entries()).sort(
    (a, b) => b[1].units - a[1].units
  );
  const top = breakdown[0];

  const dateStr = formatPktDate(start);
  const lines: string[] = [];
  lines.push(`📊 <b>DAILY STATS — ${dateStr}</b> (PKT)`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`✅ Total Units: <b>${totalUnits}</b>`);
  lines.push(`💵 Revenue: <b>${formatPKR(totalRevenue)}</b>`);
  lines.push(`🎯 Profit: <b>${formatPKR(totalProfit)}</b>`);
  lines.push(`📊 Avg Price: <b>${formatPKR(avgPrice)}/unit</b>`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(
    `🏆 TOP RESELLER: <b>${escapeHtml(top[0])}</b> (${top[1].units} units @ ${formatPKR(top[1].price)})`
  );
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`📦 BREAKDOWN BY RESELLER:`);
  for (const [name, v] of breakdown) {
    lines.push(
      `• ${escapeHtml(name)}: ${v.units} units @ ${formatPKR(v.price)} = ${formatPKR(v.revenue)} (profit: ${formatPKR(v.profit)})`
    );
  }
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  await sendMessage(chatId, lines.join("\n"));
}

/** Build and send all-time stats message (the /stats command). */
export async function sendAllTimeStats(chatId: number | string) {
  const sales = await db.sale.findMany({ orderBy: { date: "asc" } });

  if (sales.length === 0) {
    await sendMessage(
      chatId,
      `📭 <b>No sales recorded yet.</b>\n\nSend /new to log your first sale.`
    );
    return;
  }

  const totalUnits = sales.reduce((s, x) => s + x.quantity, 0);
  const totalRevenue = sales.reduce((s, x) => s + x.revenue, 0);
  const totalProfit = sales.reduce((s, x) => s + x.profit, 0);
  const avgPrice = Math.round(totalRevenue / totalUnits);
  const totalSales = sales.length;

  // Days active = distinct calendar days with at least one sale
  const distinctDays = new Set(
    sales.map((s) => pktDateKey(s.date))
  ).size;

  // Per-reseller aggregation
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
  const breakdown = Array.from(byReseller.entries()).sort(
    (a, b) => b[1].units - a[1].units
  );
  const top = breakdown[0];

  // Best day ever (by profit)
  const byDay = new Map<string, { units: number; revenue: number; profit: number }>();
  for (const s of sales) {
    const key = pktDateKey(s.date);
    const cur = byDay.get(key) ?? { units: 0, revenue: 0, profit: 0 };
    cur.units += s.quantity;
    cur.revenue += s.revenue;
    cur.profit += s.profit;
    byDay.set(key, cur);
  }
  const bestDay = Array.from(byDay.entries()).sort(
    (a, b) => b[1].profit - a[1].profit
  )[0];

  const firstSaleDate = pktDateKey(sales[0].date);
  const lastSaleDate = pktDateKey(sales[sales.length - 1].date);

  const lines: string[] = [];
  lines.push(`📈 <b>ALL-TIME STATS</b>`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`📅 Period: <b>${firstSaleDate}</b> → <b>${lastSaleDate}</b>`);
  lines.push(`🗓️ Days Active: <b>${distinctDays}</b>`);
  lines.push(`🧾 Total Sales: <b>${totalSales}</b>`);
  lines.push(`✅ Total Units: <b>${totalUnits}</b>`);
  lines.push(`💵 Total Revenue: <b>${formatPKR(totalRevenue)}</b>`);
  lines.push(`🎯 Total Profit: <b>${formatPKR(totalProfit)}</b>`);
  lines.push(`📊 Avg Price: <b>${formatPKR(avgPrice)}/unit</b>`);
  if (distinctDays > 0) {
    lines.push(`📅 Avg Profit/Day: <b>${formatPKR(Math.round(totalProfit / distinctDays))}</b>`);
  }
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(
    `🏆 TOP RESELLER: <b>${escapeHtml(top[0])}</b> (${top[1].units} units, ${top[1].sales} sales, ${formatPKR(top[1].revenue)} revenue)`
  );
  if (bestDay) {
    lines.push(
      `💎 BEST DAY: <b>${bestDay[0]}</b> (${bestDay[1].units} units, ${formatPKR(bestDay[1].profit)} profit)`
    );
  }
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`📦 ALL RESELLERS (by units):`);
  for (const [name, v] of breakdown) {
    lines.push(
      `• ${escapeHtml(name)}: ${v.units} units · ${v.sales} sales · ${formatPKR(v.revenue)} rev · ${formatPKR(v.profit)} profit`
    );
  }
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  await sendMessage(chatId, lines.join("\n"));
}

/**
 * GET /api/telegram/webhook?type=daily|stats
 * Manually trigger a stats push to the configured chat ID (used by the
 * dashboard's "Test /daily" and "Test /stats" buttons).
 */
export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type") ?? "daily";
  if (type === "stats") {
    await sendAllTimeStats(TELEGRAM_CHAT_ID);
    return NextResponse.json({ success: true, message: "All-time stats sent to chat." });
  }
  await sendTodaySummary(TELEGRAM_CHAT_ID);
  return NextResponse.json({ success: true, message: "Daily stats sent to chat." });
}
