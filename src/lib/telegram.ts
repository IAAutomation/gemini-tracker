/**
 * Telegram Bot Helper
 * Handles Telegram API calls and conversation state for the /new sale flow.
 *
 * /new shows a single menu message with three rows of inline buttons:
 *   Row 1 — reseller (Ali / Omar / Karim / Suhail / ✍️ Custom)
 *   Row 2 — quantity (1 / 2 / 3 / 4 / 5 / 6)
 *   Row 3 — price    (400 / 500 / 550 / 600)
 *   Row 4 — Submit
 *
 * The user taps options in any order; the message live-updates to show ✅
 * next to whatever they've picked. Submit only completes the sale once all
 * three fields are set.
 */

export const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || "8992554756:AAHIdtvD7caRbnO8ybQtJSJNTNuT1cXJIx8";
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "7281195843";
export const TELEGRAM_API_BASE = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// Allowed wholesale prices (PKR)
export const ALLOWED_PRICES = [400, 500, 550, 600] as const;
export const COST_PER_UNIT = 250; // PKR — used to compute profit

// Pre-defined resellers + common quantities that appear as tappable buttons.
export const KNOWN_RESELLERS = ["Mehroz", "Salaar", "Zain", "Fahad"] as const;
export const COMMON_QUANTITIES = [1, 2, 3, 4, 5, 6] as const;

export type PaymentStatus = "processing" | "done";

export type ConversationState = {
  /**
   * "menu"           = waiting for the user to tap option buttons (/new flow)
   * "custom_name"    = waiting for next text message → reseller name
   * "custom_qty"     = waiting for next text message → quantity (positive integer)
   * "custom_price"   = waiting for next text message → price per unit (positive integer)
   * "custom_link"    = waiting for next text message → Gemini activation link
   * "search_query"  = waiting for next text message → free-text search query
   * "compare_query" = waiting for next text message → "X vs Y" comparison
   * "confirm_delete" = waiting for next text message → "DELETE" to confirm sale deletion
   * "edit_link"      = waiting for next text message → new Gemini activation link
   * "edit_setting"   = waiting for next text message → new value for a setting key
   * "admin_password" = waiting for next text message → admin panel password
   */
  step:
    | "menu"
    | "custom_name"
    | "custom_qty"
    | "custom_price"
    | "custom_link"
    | "search_query"
    | "compare_query"
    | "confirm_delete"
    | "edit_link"
    | "edit_setting"
    | "admin_password";
  resellerName?: string;
  quantity?: number;
  price?: number;
  payment?: PaymentStatus;
  /** Optional Gemini activation link attached to a new sale (/new flow). */
  geminiLink?: string;
  /** The menu message id, used so we can edit it in place as the user picks options. */
  messageId?: number;
  /** Sale id being deleted/edited in the /sales action flow. */
  pendingSaleId?: string;
  /** PKT year/month/day of the sale being acted on (used to re-render the day view). */
  pendingSaleYear?: number;
  pendingSaleMonth?: number;
  pendingSaleDay?: number;
  /** Setting key currently being edited in the /settings flow. */
  editSettingKey?: string;
  /**
   * Target PKT date when adding units to a specific day from the /sale calendar.
   * When set, the /new submit handler overrides the sale's date with
   * `pktMidnightUtc(year, month, day) + current PKT time-of-day offset`,
   * then re-renders the /sale day view for that date.
   */
  addDate?: { year: number; month: number; day: number };
};

// In-memory conversation store keyed by telegram user id.
const conversations = new Map<number, ConversationState>();

export function getConversation(userId: number): ConversationState {
  if (!conversations.has(userId)) {
    conversations.set(userId, { step: "menu" });
  }
  return conversations.get(userId)!;
}

export function setConversation(userId: number, state: ConversationState) {
  conversations.set(userId, state);
}

export function clearConversation(userId: number) {
  conversations.delete(userId);
}

// ============================================================
// ADMIN AUTH (in-memory, HMR-safe via globalThis)
// ============================================================
//
// /admin requires a password (configured via the `adminPassword` setting,
// default "Iht@Admin"). Once a user enters the correct password, their
// telegram user id is added to this Set so they can re-enter /admin without
// re-authenticating until the server restarts.
//
// The owner's hardcoded chat id (7281195843) always bypasses the password.

const OWNER_CHAT_ID = 7281195843;

type AdminGlobal = { __adminAuthedUsers?: Set<number> };
const adminG = globalThis as unknown as AdminGlobal;
if (!adminG.__adminAuthedUsers) adminG.__adminAuthedUsers = new Set<number>();
/** Set of telegram user ids that have authenticated via /admin password. */
export const adminAuthedUsers: Set<number> = adminG.__adminAuthedUsers;

/**
 * Returns true if `chatId` is the owner (hardcoded 7281195843) OR `fromId`
 * has been added to `adminAuthedUsers` by entering the /admin password.
 */
export function isOwnerOrAdminAuthed(
  chatId: number | string | undefined,
  fromId: number | undefined
): boolean {
  const cid = Number(chatId);
  if (Number.isFinite(cid) && cid === OWNER_CHAT_ID) return true;
  if (fromId !== undefined && adminAuthedUsers.has(fromId)) return true;
  return false;
}

async function tgCall(method: string, body: Record<string, unknown>) {
  const res = await fetch(`${TELEGRAM_API_BASE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram API ${method} failed: ${data.description || JSON.stringify(data)}`);
  }
  return data;
}

export async function sendMessage(
  chatId: number | string,
  text: string,
  extra: Record<string, unknown> = {}
) {
  return tgCall("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...extra,
  });
}

export async function editMessageText(
  chatId: number | string,
  messageId: number,
  text: string,
  replyMarkup?: unknown
) {
  return tgCall("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    reply_markup: replyMarkup,
  });
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  return tgCall("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
  });
}

/** Build the multi-row inline keyboard for the /new menu. */
export function buildMenuKeyboard(state: ConversationState) {
  const resellerButtons = KNOWN_RESELLERS.map((name) => ({
    text: state.resellerName === name ? `✅ ${name}` : name,
    callback_data: `reseller_${name}`,
  }));
  // The "Custom" / current custom-name slot
  const isCustom =
    state.resellerName && !KNOWN_RESELLERS.includes(state.resellerName as never);
  resellerButtons.push({
    text: isCustom ? `✅ ${state.resellerName!.slice(0, 14)}` : "✍️ Custom",
    callback_data: "custom_name",
  });

  const qtyButtons = COMMON_QUANTITIES.map((q) => ({
    text: state.quantity === q ? `✅ ${q}` : `${q}`,
    callback_data: `qty_${q}`,
  }));
  // Custom quantity slot (if user typed a non-preset value, show it ✅)
  const isCustomQty =
    state.quantity && !COMMON_QUANTITIES.includes(state.quantity as never);
  qtyButtons.push({
    text: isCustomQty ? `✅ ${state.quantity}` : "✍️ Custom",
    callback_data: "custom_qty",
  });

  const priceButtons = ALLOWED_PRICES.map((p) => ({
    text: state.price === p ? `✅ ${p}` : `${p}`,
    callback_data: `price_${p}`,
  }));
  // Custom price slot (if user typed a non-preset value, show it ✅)
  const isCustomPrice =
    state.price && !ALLOWED_PRICES.includes(state.price as never);
  priceButtons.push({
    text: isCustomPrice ? `✅ ${state.price}` : "✍️ Custom",
    callback_data: "custom_price",
  });

  // Payment row — Done / Processing. Defaults to Processing on a fresh menu.
  const payment = state.payment ?? "processing";
  const paymentButtons = [
    {
      text: payment === "done" ? "✅ 💰 Done" : "💰 Done",
      callback_data: "pay_done",
    },
    {
      text: payment === "processing" ? "✅ ⏳ Processing" : "⏳ Processing",
      callback_data: "pay_processing",
    },
  ];

  // Link row — set Gemini activation link, or skip.
  // If a link is already set, the first button shows ✅ + "Link Set".
  // Either way, "Skip" advances to submit (Skip clears the link to "").
  const hasLink = !!(state.geminiLink && state.geminiLink.length > 0);
  const linkButtons = [
    {
      text: hasLink ? "✅ 🔗 Link Set" : "🔗 Add Link",
      callback_data: "custom_link",
    },
    {
      text: "⏭ Skip",
      callback_data: "skip_link",
    },
  ];

  // All 4 required fields: reseller, quantity, price, payment.
  // (Payment defaults to "processing" so technically it's always set, but we
  // still want the user to consciously confirm it before submit.)
  const allSet = state.resellerName && state.quantity && state.price && state.payment;
  const submitButton = {
    text: allSet ? "🚀 Submit Unit" : "🔒 Pick name, qty, price, payment",
    callback_data: "submit",
  };

  const cancelButton = {
    text: "❌ Cancel",
    callback_data: "cancel",
  };

  return {
    inline_keyboard: [
      resellerButtons,
      qtyButtons,
      priceButtons,
      paymentButtons,
      linkButtons,
      [submitButton, cancelButton],
    ],
  };
}

/** Build the body of the menu message — shows current selections at the top. */
export function menuText(state: ConversationState): string {
  const r = state.resellerName
    ? `<b>${escapeHtml(state.resellerName)}</b> ✅`
    : "<i>not selected</i>";
  const q = state.quantity ? `<b>${state.quantity}</b> ✅` : "<i>not selected</i>";
  const p = state.price ? `<b>${state.price} PKR</b> ✅` : "<i>not selected</i>";
  const payment = state.payment ?? "processing";
  const pay = payment === "done"
    ? `<b>💰 Done</b> ✅`
    : `<b>⏳ Processing</b> ✅`;
  const link = state.geminiLink && state.geminiLink.length > 0
    ? `<code>${escapeHtml(state.geminiLink)}</code> ✅`
    : "<i>not set</i>";

  const revenue =
    state.quantity && state.price ? state.quantity * state.price : null;
  const profit =
    state.quantity && state.price
      ? (state.price - COST_PER_UNIT) * state.quantity
      : null;

  const preview =
    revenue !== null
      ? `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n💰 Revenue: <b>${formatPKR(revenue)}</b>\n🎯 Profit:  <b>${formatPKR(profit!)}</b>  <i>(cost 250/unit)</i>`
      : "";

  return [
    "📝 <b>NEW UNIT ENTRY</b>",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `👤 Reseller:  ${r}`,
    `📦 Quantity:  ${q}`,
    `💵 Price:     ${p}`,
    `💳 Payment:   ${pay}`,
    `🔗 Link:      ${link}`,
    preview,
    "",
    "👇 Tap buttons below, then press <b>Submit</b>.",
  ].join("\n");
}

/** Format an integer as PKR currency string. */
export function formatPKR(amount: number): string {
  return `${amount.toLocaleString("en-PK")} PKR`;
}

/** Escape HTML special characters in user-provided text. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** A sale row, as returned by GET /api/sales. */
export type SaleRow = {
  id: string;
  date: string;
  resellerName: string;
  quantity: number;
  pricePerUnit: number;
  revenue: number;
  profit: number;
  paymentStatus: PaymentStatus;
  /** Optional Gemini activation link attached to the sale. */
  geminiLink?: string;
};

/** Format a payment status as an emoji-prefixed label. */
export function formatPayment(p: PaymentStatus): string {
  return p === "done" ? "💰 Done" : "⏳ Processing";
}

/**
 * Build the inline keyboard for the /sale (today's sales) list.
 * Each sale gets a "🗑 #N" button whose callback_data encodes the sale id.
 * Telegram callback_data has a 64-byte limit, so we use a short prefix +
 * the full sale id (cuid, ~24 chars — well within the limit).
 */
export function buildSalesListKeyboard(sales: SaleRow[]) {
  const rows: { text: string; callback_data: string }[][] = [];
  // One delete button per row (full-width, easier to tap)
  for (let i = 0; i < sales.length; i++) {
    const s = sales[i];
    const label = `🗑 #${i + 1} ${s.resellerName.slice(0, 12)} · ${s.quantity}×${s.pricePerUnit} · ${formatPayment(s.paymentStatus)}`;
    rows.push([
      {
        text: label,
        callback_data: `del_${s.id}`,
      },
    ]);
  }
  rows.push([
    { text: "🔄 Refresh", callback_data: "sales_refresh" },
    { text: "❌ Close", callback_data: "sales_close" },
  ]);
  return { inline_keyboard: rows };
}

/** Build the body of the /sale (today's units) list message. */
export function salesListText(sales: SaleRow[]): string {
  if (sales.length === 0) {
    return [
      "📋 <b>TODAY'S UNITS</b>",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "",
      "📭 No units recorded today yet.",
      "",
      "Send /new to log your first unit.",
    ].join("\n");
  }

  const totalUnits = sales.reduce((s, x) => s + x.quantity, 0);
  const totalRevenue = sales.reduce((s, x) => s + x.revenue, 0);
  const totalProfit = sales.reduce((s, x) => s + x.profit, 0);
  const doneCount = sales.filter((s) => s.paymentStatus === "done").length;

  const lines: string[] = [];
  lines.push("📋 <b>TODAY'S UNITS</b> (PKT)");
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`🧾 Entries: <b>${sales.length}</b>  ·  📦 Units: <b>${totalUnits}</b>`);
  lines.push(`💰 Revenue: <b>${formatPKR(totalRevenue)}</b>  ·  🎯 Profit: <b>${formatPKR(totalProfit)}</b>`);
  lines.push(`💳 Paid: <b>${doneCount}/${sales.length}</b>`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  sales.forEach((s, i) => {
    const d = new Date(s.date);
    const timeStr = d.toLocaleTimeString("en-US", { timeZone: "Asia/Karachi", hour: "numeric", minute: "2-digit" });
    lines.push(
      `<b>#${i + 1}</b> ${escapeHtml(s.resellerName)} · ${s.quantity}×${formatPKR(s.pricePerUnit)}`
    );
    lines.push(`    ${formatPKR(s.revenue)} rev · ${formatPKR(s.profit)} profit · ${formatPayment(s.paymentStatus)} · ${timeStr}`);
  });
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("👇 Tap a 🗑 button below to delete that unit.");
  return lines.join("\n");
}

/**
 * Build the inline keyboard for the /pay (today's payments) list.
 * Each sale gets a toggle button — tap to flip between Done and Processing.
 */
export function buildPaymentKeyboard(sales: SaleRow[]) {
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < sales.length; i++) {
    const s = sales[i];
    const current = formatPayment(s.paymentStatus);
    const flipTo = s.paymentStatus === "done" ? "⏳ Processing" : "💰 Done";
    const label = `#${i + 1} ${s.resellerName.slice(0, 12)} · ${s.quantity}×${s.pricePerUnit} · now: ${current} → tap for ${flipTo}`;
    rows.push([
      {
        text: label,
        callback_data: `paytoggle_${s.id}`,
      },
    ]);
  }
  rows.push([
    { text: "🔄 Refresh", callback_data: "pay_refresh" },
    { text: "❌ Close", callback_data: "pay_close" },
  ]);
  return { inline_keyboard: rows };
}

/** Build the body of the /pay (today's payments) list message. */
export function paymentListText(sales: SaleRow[]): string {
  if (sales.length === 0) {
    return [
      "💳 <b>TODAY'S PAYMENTS</b> (PKT)",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "",
      "📭 No units recorded today yet.",
      "",
      "Send /new to log a unit first.",
    ].join("\n");
  }

  const doneCount = sales.filter((s) => s.paymentStatus === "done").length;
  const processingCount = sales.length - doneCount;
  const doneRevenue = sales
    .filter((s) => s.paymentStatus === "done")
    .reduce((s, x) => s + x.revenue, 0);
  const pendingRevenue = sales
    .filter((s) => s.paymentStatus === "processing")
    .reduce((s, x) => s + x.revenue, 0);
  const collectionRate = (doneRevenue + pendingRevenue) > 0
    ? Math.round((doneRevenue / (doneRevenue + pendingRevenue)) * 100)
    : 0;

  const lines: string[] = [];
  lines.push("💳 <b>TODAY'S PAYMENTS</b> (PKT)");
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`✅ Paid: <b>${doneCount}</b> (${formatPKR(doneRevenue)})`);
  lines.push(`⏳ Pending: <b>${processingCount}</b> (${formatPKR(pendingRevenue)})`);
  lines.push(`📈 Collection rate: <b>${collectionRate}%</b>`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  sales.forEach((s, i) => {
    const d = new Date(s.date);
    const timeStr = d.toLocaleTimeString("en-US", { timeZone: "Asia/Karachi", hour: "numeric", minute: "2-digit" });
    lines.push(
      `<b>#${i + 1}</b> ${escapeHtml(s.resellerName)} · ${s.quantity}×${formatPKR(s.pricePerUnit)} = ${formatPKR(s.revenue)}`
    );
    lines.push(`    → ${formatPayment(s.paymentStatus)} · ${timeStr}`);
  });
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("👇 Tap a button below to flip a unit's payment status.");
  return lines.join("\n");
}

// ============================================================
// CALENDAR (for /stats command)
// ============================================================

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const WEEKDAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** Format a YYYY-MM-DD string from parts. */
function fmtDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Build the year+month picker keyboard for /stats.
 *
 * Layout:
 *   Row 1: ◀ 2025  |  ✅ 2026  |  2027 ▶
 *   Row 2-5: 3 months per row, with 📊 badge if sales exist that month
 *
 * `salesByMonth` is a Map<"YYYY-MM", count> showing which months have sales.
 */
export function buildCalendarYearKeyboard(
  year: number,
  salesByMonth: Map<string, number>
) {
  const yearRow = [
    { text: `◀ ${year - 1}`, callback_data: `cy_${year - 1}` },
    { text: `✅ ${year}`, callback_data: `cy_${year}` },
    { text: `${year + 1} ▶`, callback_data: `cy_${year + 1}` },
  ];

  const monthRows: { text: string; callback_data: string }[][] = [];
  for (let row = 0; row < 4; row++) {
    const r: { text: string; callback_data: string }[] = [];
    for (let col = 0; col < 3; col++) {
      const m = row * 3 + col + 1;
      const key = `${year}-${String(m).padStart(2, "0")}`;
      const count = salesByMonth.get(key) ?? 0;
      const label = count > 0
        ? `${MONTH_NAMES[m - 1].slice(0, 3)} 📊${count}`
        : MONTH_NAMES[m - 1].slice(0, 3);
      r.push({
        text: label,
        callback_data: `cm_${year}_${m}`,
      });
    }
    monthRows.push(r);
  }

  return {
    inline_keyboard: [yearRow, ...monthRows, [{ text: "❌ Close", callback_data: "cal_close" }]],
  };
}

/** Text for the year+month picker view. */
export function calendarYearText(year: number, salesByMonth: Map<string, number>): string {
  const totalThisYear = Array.from(salesByMonth.values()).reduce((a, b) => a + b, 0);
  const monthsWithSales = Array.from(salesByMonth.values()).filter((c) => c > 0).length;
  return [
    "📅 <b>UNITS CALENDAR</b> (PKT)",
    "",
    `Year: <b>${year}</b>`,
    `📊 ${totalThisYear} units across ${monthsWithSales} month(s)`,
    "",
    "👇 Tap a month to see its days + weekly/monthly overview:",
  ].join("\n");
}

/**
 * Build the day-grid keyboard for a specific (year, month).
 * Uses PKT weekday calculation (passed in as `startOffset`) and PKT days-in-month
 * (passed in as `daysInMonth`) so the grid matches Peshawar time.
 */
export function buildCalendarMonthKeyboard(
  year: number,
  month: number,
  salesByDay: Map<string, number>,
  startOffset: number,
  daysInMonth: number
) {
  // Header row
  const headerRow = [
    { text: "◀ Back", callback_data: `cb_year_${year}` },
    { text: "📊 Monthly Overview", callback_data: `mo_${year}_${month}` },
    { text: "📅 Weekly Breakdown", callback_data: `wb_${year}_${month}` },
  ];

  // Weekday labels
  const labelRow = WEEKDAY_LABELS.map((w) => ({
    text: w,
    callback_data: "noop",
  }));

  const dayRows: { text: string; callback_data: string }[][] = [];
  let currentRow: { text: string; callback_data: string }[] = [];

  // Pad before first day
  for (let i = 0; i < startOffset; i++) {
    currentRow.push({ text: " ", callback_data: "noop" });
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const key = fmtDate(year, month, day);
    const count = salesByDay.get(key) ?? 0;
    const label = count > 0 ? `✅${day}` : `${day}`;
    currentRow.push({
      text: label,
      callback_data: `cd_${year}_${month}_${day}`,
    });
    if (currentRow.length === 7) {
      dayRows.push(currentRow);
      currentRow = [];
    }
  }
  // Pad after last day
  if (currentRow.length > 0) {
    while (currentRow.length < 7) {
      currentRow.push({ text: " ", callback_data: "noop" });
    }
    dayRows.push(currentRow);
  }

  return {
    inline_keyboard: [headerRow, labelRow, ...dayRows],
  };
}

/** Text for the month view (day grid). */
export function calendarMonthText(
  year: number,
  month: number,
  salesByDay: Map<string, number>
): string {
  const totalThisMonth = Array.from(salesByDay.values()).reduce((a, b) => a + b, 0);
  const daysWithSales = Array.from(salesByDay.values()).filter((c) => c > 0).length;
  return [
    `📅 <b>${MONTH_NAMES[month - 1]} ${year}</b> (PKT)`,
    "",
    `📊 ${totalThisMonth} units across ${daysWithSales} day(s)`,
    "",
    "✅ = day with units · tap any day for details",
    "📊 Monthly Overview = full month summary",
    "📅 Weekly Breakdown = week-by-week stats",
  ].join("\n");
}

/** Build the day-view keyboard (single day's sales + back button). */
export function buildCalendarDayKeyboard(year: number, month: number) {
  return {
    inline_keyboard: [
      [
        { text: "◀ Back to month", callback_data: `cm_${year}_${month}` },
        { text: "❌ Close", callback_data: "cal_close" },
      ],
    ],
  };
}

// ============================================================
// PAYMENT CALENDAR (for /pay command)
// ============================================================

/**
 * Build the year+month picker keyboard for /pay.
 * Same layout as the /stats calendar but months are badged with
 * payment counts (💰N/⏳M) instead of total sales.
 *
 * `paymentByMonth` is a Map<"YYYY-MM", { paid: number, pending: number }>.
 */
export function buildPayCalendarYearKeyboard(
  year: number,
  paymentByMonth: Map<string, { paid: number; pending: number }>
) {
  const yearRow = [
    { text: `◀ ${year - 1}`, callback_data: `py_${year - 1}` },
    { text: `✅ ${year}`, callback_data: `py_${year}` },
    { text: `${year + 1} ▶`, callback_data: `py_${year + 1}` },
  ];

  const monthRows: { text: string; callback_data: string }[][] = [];
  for (let row = 0; row < 4; row++) {
    const r: { text: string; callback_data: string }[] = [];
    for (let col = 0; col < 3; col++) {
      const m = row * 3 + col + 1;
      const key = `${year}-${String(m).padStart(2, "0")}`;
      const p = paymentByMonth.get(key);
      const label = p && (p.paid + p.pending > 0)
        ? `${MONTH_NAMES[m - 1].slice(0, 3)} 💰${p.paid}/⏳${p.pending}`
        : MONTH_NAMES[m - 1].slice(0, 3);
      r.push({
        text: label,
        callback_data: `pm_${year}_${m}`,
      });
    }
    monthRows.push(r);
  }

  return {
    inline_keyboard: [
      yearRow,
      ...monthRows,
      [{ text: "❌ Close", callback_data: "cal_close" }],
    ],
  };
}

/** Text for the /pay year+month picker. */
export function payCalendarYearText(
  year: number,
  paymentByMonth: Map<string, { paid: number; pending: number }>
): string {
  let totalPaid = 0;
  let totalPending = 0;
  for (const v of paymentByMonth.values()) {
    totalPaid += v.paid;
    totalPending += v.pending;
  }
  return [
    "💳 <b>PAYMENT CALENDAR</b>",
    "",
    `Year: <b>${year}</b>`,
    `💰 ${totalPaid} paid · ⏳ ${totalPending} pending`,
    "",
    "👇 Tap a month to see its days:",
  ].join("\n");
}

/**
 * Build the day-grid keyboard for /pay (specific month).
 * Days are badged: ✅ if all paid · ⏳ if all pending · 🔀 if mixed.
 */
export function buildPayCalendarMonthKeyboard(
  year: number,
  month: number,
  paymentByDay: Map<string, { paid: number; pending: number }>,
  startOffset: number,
  daysInMonth: number
) {
  const headerRow = [
    { text: "◀ Back", callback_data: `pb_year_${year}` },
    { text: "📊 Month Overview", callback_data: `pmo_${year}_${month}` },
  ];

  const labelRow = WEEKDAY_LABELS.map((w) => ({
    text: w,
    callback_data: "noop",
  }));

  const dayRows: { text: string; callback_data: string }[][] = [];
  let currentRow: { text: string; callback_data: string }[] = [];
  for (let i = 0; i < startOffset; i++) {
    currentRow.push({ text: " ", callback_data: "noop" });
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const key = fmtDate(year, month, day);
    const p = paymentByDay.get(key);
    let label = `${day}`;
    if (p && (p.paid + p.pending > 0)) {
      if (p.pending === 0) label = `✅${day}`;
      else if (p.paid === 0) label = `⏳${day}`;
      else label = `🔀${day}`;
    }
    currentRow.push({
      text: label,
      callback_data: `pd_${year}_${month}_${day}`,
    });
    if (currentRow.length === 7) {
      dayRows.push(currentRow);
      currentRow = [];
    }
  }
  if (currentRow.length > 0) {
    while (currentRow.length < 7) {
      currentRow.push({ text: " ", callback_data: "noop" });
    }
    dayRows.push(currentRow);
  }

  return {
    inline_keyboard: [headerRow, labelRow, ...dayRows],
  };
}

/** Text for the /pay month view. */
export function payCalendarMonthText(
  year: number,
  month: number,
  paymentByDay: Map<string, { paid: number; pending: number }>
): string {
  let totalPaid = 0;
  let totalPending = 0;
  let daysWithSales = 0;
  for (const v of paymentByDay.values()) {
    totalPaid += v.paid;
    totalPending += v.pending;
    if (v.paid + v.pending > 0) daysWithSales++;
  }
  return [
    `💳 <b>${MONTH_NAMES[month - 1]} ${year}</b>`,
    "",
    `💰 ${totalPaid} paid · ⏳ ${totalPending} pending · 📅 ${daysWithSales} day(s)`,
    "",
    "✅ all paid · ⏳ all pending · 🔀 mixed",
    "Tap any day to view + toggle payments",
  ].join("\n");
}

/** Build the /pay day-view keyboard (toggle buttons for each sale + back). */
export function buildPayDayKeyboard(
  year: number,
  month: number,
  sales: SaleRow[]
) {
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < sales.length; i++) {
    const s = sales[i];
    const current = formatPayment(s.paymentStatus);
    const flipTo = s.paymentStatus === "done" ? "⏳→Pending" : "💰→Done";
    const label = `#${i + 1} ${s.resellerName.slice(0, 12)} · ${s.quantity}×${s.pricePerUnit} · now: ${current} → tap ${flipTo}`;
    rows.push([
      {
        text: label,
        callback_data: `ptoggle_${s.id}`,
      },
    ]);
  }
  rows.push([
    { text: "◀ Back to month", callback_data: `pm_${year}_${month}` },
    { text: "❌ Close", callback_data: "cal_close" },
  ]);
  return { inline_keyboard: rows };
}

// ============================================================
// SALES CALENDAR (for /sale command — merged /pay flow)
// ============================================================
//
// Same visual layout as the /stats calendar, but with its own callback
// prefix (`scy_` / `scm_` / `scd_`) so the day-detail view can show the
// per-unit action buttons (delete / edit link / toggle pay) instead of
// the read-only stats breakdown.

/**
 * Build the year+month picker keyboard for /sale.
 * Same layout as `buildCalendarYearKeyboard` but with `scy_` / `scm_`
 * callbacks so taps route to the /sales handler.
 */
export function buildSalesCalendarYearKeyboard(
  year: number,
  salesByMonth: Map<string, number>
) {
  const yearRow = [
    { text: `◀ ${year - 1}`, callback_data: `scy_${year - 1}` },
    { text: `✅ ${year}`, callback_data: `scy_${year}` },
    { text: `${year + 1} ▶`, callback_data: `scy_${year + 1}` },
  ];

  const monthRows: { text: string; callback_data: string }[][] = [];
  for (let row = 0; row < 4; row++) {
    const r: { text: string; callback_data: string }[] = [];
    for (let col = 0; col < 3; col++) {
      const m = row * 3 + col + 1;
      const key = `${year}-${String(m).padStart(2, "0")}`;
      const count = salesByMonth.get(key) ?? 0;
      const label = count > 0
        ? `${MONTH_NAMES[m - 1].slice(0, 3)} 📊${count}`
        : MONTH_NAMES[m - 1].slice(0, 3);
      r.push({
        text: label,
        callback_data: `scm_${year}_${m}`,
      });
    }
    monthRows.push(r);
  }

  return {
    inline_keyboard: [
      yearRow,
      ...monthRows,
      [{ text: "❌ Close", callback_data: "sclose" }],
    ],
  };
}

/** Text for the /sale year+month picker view. */
export function salesCalendarYearText(
  year: number,
  salesByMonth: Map<string, number>
): string {
  const totalThisYear = Array.from(salesByMonth.values()).reduce((a, b) => a + b, 0);
  const monthsWithSales = Array.from(salesByMonth.values()).filter((c) => c > 0).length;
  return [
    "📅 <b>UNITS MANAGER</b> (PKT)",
    "",
    `Year: <b>${year}</b>`,
    `📊 ${totalThisYear} units across ${monthsWithSales} month(s)`,
    "",
    "👇 Tap a month, then a day, then a unit to edit/delete/toggle:",
  ].join("\n");
}

/**
 * Build the day-grid keyboard for /sale (specific month).
 * Same visual layout as `buildCalendarMonthKeyboard` but with `scm_` /
 * `scd_` callbacks. The "Monthly Overview" + "Weekly Breakdown" buttons
 * are omitted — this view is for managing units, not browsing stats.
 */
export function buildSalesCalendarMonthKeyboard(
  year: number,
  month: number,
  salesByDay: Map<string, number>,
  startOffset: number,
  daysInMonth: number
) {
  const headerRow = [
    { text: "◀ Back", callback_data: `scb_year_${year}` },
    { text: "❌ Close", callback_data: "sclose" },
  ];

  const labelRow = WEEKDAY_LABELS.map((w) => ({
    text: w,
    callback_data: "noop",
  }));

  const dayRows: { text: string; callback_data: string }[][] = [];
  let currentRow: { text: string; callback_data: string }[] = [];

  for (let i = 0; i < startOffset; i++) {
    currentRow.push({ text: " ", callback_data: "noop" });
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const key = fmtDate(year, month, day);
    const count = salesByDay.get(key) ?? 0;
    const label = count > 0 ? `✅${day}` : `${day}`;
    currentRow.push({
      text: label,
      callback_data: `scd_${year}_${month}_${day}`,
    });
    if (currentRow.length === 7) {
      dayRows.push(currentRow);
      currentRow = [];
    }
  }
  if (currentRow.length > 0) {
    while (currentRow.length < 7) {
      currentRow.push({ text: " ", callback_data: "noop" });
    }
    dayRows.push(currentRow);
  }

  return {
    inline_keyboard: [headerRow, labelRow, ...dayRows],
  };
}

/** Text for the /sale month view (day grid). */
export function salesCalendarMonthText(
  year: number,
  month: number,
  salesByDay: Map<string, number>
): string {
  const totalThisMonth = Array.from(salesByDay.values()).reduce((a, b) => a + b, 0);
  const daysWithSales = Array.from(salesByDay.values()).filter((c) => c > 0).length;
  return [
    `📅 <b>${MONTH_NAMES[month - 1]} ${year}</b> (PKT) — Manage`,
    "",
    `📊 ${totalThisMonth} units across ${daysWithSales} day(s)`,
    "",
    "✅ = day with units · tap any day to manage its units",
  ].join("\n");
}

/**
 * Build the /sale day-view keyboard — one button per sale plus back/close.
 * Each sale button's callback is `sact_<saleId>` which opens the action
 * menu (delete / edit link / toggle pay).
 *
 * `day` is the PKT day-of-month so we can build the `sadd_<y>_<m>_<d>`
 * callback for the "Add Units to This Day" button (lets the user create
 * a new sale back-dated to this specific calendar day without leaving the
 * day-detail view).
 */
export function buildSalesDayKeyboard(
  year: number,
  month: number,
  sales: SaleRow[],
  day?: number
) {
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < sales.length; i++) {
    const s = sales[i];
    const payEmoji = s.paymentStatus === "done" ? "✅" : "⏳";
    const linkEmoji = s.geminiLink && s.geminiLink.length > 0 ? " 🔗" : "";
    const label = `#${i + 1} ${s.resellerName.slice(0, 12)} ${s.quantity}×${s.pricePerUnit} ${payEmoji}${linkEmoji}`;
    rows.push([
      {
        text: label,
        callback_data: `sact_${s.id}`,
      },
    ]);
  }
  // "Add Units to This Day" — opens the /new menu flow with the target date
  // stored in conversation state, so the new sale is back-dated to this day.
  if (day !== undefined) {
    rows.push([
      {
        text: "➕ Add Units to This Day",
        callback_data: `sadd_${year}_${month}_${day}`,
      },
    ]);
  }
  rows.push([
    { text: "◀ Back to month", callback_data: `scm_${year}_${month}` },
    { text: "❌ Close", callback_data: "sclose" },
  ]);
  return { inline_keyboard: rows };
}

/** Build the body of the /sale day-detail message — totals + sale list prompt. */
export function salesDayText(
  dateLabel: string,
  sales: SaleRow[]
): string {
  const lines: string[] = [];
  lines.push(`📋 <b>UNITS — ${escapeHtml(dateLabel)}</b> (PKT)`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  if (sales.length === 0) {
    lines.push("📭 No units recorded on this day.");
    lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    lines.push("[◀ Back to month] [❌ Close]");
    return lines.join("\n");
  }

  const totalUnits = sales.reduce((s, x) => s + x.quantity, 0);
  const paidCount = sales.filter((s) => s.paymentStatus === "done").length;
  const pendingCount = sales.length - paidCount;
  const paidRevenue = sales
    .filter((s) => s.paymentStatus === "done")
    .reduce((s, x) => s + x.revenue, 0);
  const pendingRevenue = sales
    .filter((s) => s.paymentStatus !== "done")
    .reduce((s, x) => s + x.revenue, 0);

  lines.push(`📊 ${totalUnits} units · ${paidCount} paid / ${pendingCount} pending`);
  lines.push(`💰 Collected: ${formatPKR(paidRevenue)} · ⏳ Outstanding: ${formatPKR(pendingRevenue)}`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push("👇 Tap a unit to edit/delete/toggle:");
  return lines.join("\n");
}

/**
 * Build the action-menu keyboard for a specific sale.
 * 3 action buttons in one row + a back button.
 */
export function buildSalesActionKeyboard(
  year: number,
  month: number,
  saleId: string
) {
  return {
    inline_keyboard: [
      [
        { text: "🗑 Delete", callback_data: `sdel_${saleId}` },
        { text: "✏️ Edit Link", callback_data: `sedit_${saleId}` },
        { text: "💳 Toggle Payment", callback_data: `sptog_${saleId}` },
      ],
      [
        { text: "◀ Back to day", callback_data: `sback_${year}_${month}` },
      ],
    ],
  };
}

/** Build the body of the action-menu message — sale summary + prompt. */
export function salesActionText(sale: SaleRow): string {
  const payment = sale.paymentStatus === "done" ? "💰 Done" : "⏳ Pending";
  const link = sale.geminiLink && sale.geminiLink.length > 0
    ? escapeHtml(sale.geminiLink)
    : "<i>no link set</i>";
  return [
    `📦 <b>${escapeHtml(sale.resellerName)}</b> · ${sale.quantity}×${formatPKR(sale.pricePerUnit)} = ${formatPKR(sale.revenue)}`,
    `${payment} | 🎯 ${formatPKR(sale.profit)} profit`,
    `🔗 ${link}`,
    "",
    "Choose action:",
  ].join("\n");
}

// ============================================================
// RESELLER .TXT REPORTS (analysis + share)
// ============================================================

/** Truncate a string to `max` chars, appending "…" if it was cut. */
function truncateLink(s: string, max = 30): string {
  if (!s) return "-";
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** Pad a string to `width` chars (right-padded with spaces). */
function padR(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + " ".repeat(width - s.length);
}

/** Pad a string to `width` chars (left-padded with spaces — for numbers). */
function padL(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return " ".repeat(width - s.length) + s;
}

/**
 * Build a top-of-report banner using double-line box drawing.
 * `title` and `subtitle` are placed on their own lines inside the box,
 * both left-aligned with consistent padding so the right border aligns.
 */
function buildReportBanner(title: string, subtitle: string, innerWidth = 50): string {
  const top = "╔" + "═".repeat(innerWidth) + "╗";
  const bot = "╚" + "═".repeat(innerWidth) + "╝";
  const tLine = "║  " + padR(title, innerWidth - 2) + "║";
  const sLine = "║  " + padR(subtitle, innerWidth - 2) + "║";
  return [top, tLine, sLine, bot].join("\n");
}

/**
 * Build a single-row "info card" box using single-line box drawing.
 * `rows` is a list of [label, value] pairs, each rendered as:
 *   │  Label:    Value                            │
 * with the values left-aligned at a consistent column.
 */
function buildInfoCard(
  rows: [string, string][],
  innerWidth = 52
): string {
  const top = "┌" + "─".repeat(innerWidth) + "┐";
  const bot = "└" + "─".repeat(innerWidth) + "┘";
  const mid = "├" + "─".repeat(innerWidth) + "┤";
  const lines = [top];
  let first = true;
  for (const [label, value] of rows) {
    if (!first) lines.push(mid);
    first = false;
    const content = `  ${label}${value}`;
    lines.push("│" + padR(content, innerWidth) + "│");
  }
  lines.push(bot);
  return lines.join("\n");
}

/**
 * Build a table using single-line box drawing with column separators.
 * `headers` and `rows` are arrays of strings; `widths` defines the total
 * width of each column (including 1-char padding on each side).
 * `aligns` (optional) is "l" / "r" / "c" per column (default "l").
 */
function buildTable(
  headers: string[],
  rows: string[][],
  widths: number[],
  aligns: ("l" | "r" | "c")[] = []
): string {
  const align: ("l" | "r" | "c")[] = widths.map((_, i) => aligns[i] ?? "l");

  /** Pad/truncate `s` to exactly `w` chars with optional alignment.
   *  1 char of space padding is added on each side, so the inner content
   *  width is `w - 2`. */
  function cell(s: string, w: number, a: "l" | "r" | "c"): string {
    const inner = Math.max(0, w - 2);
    const str = String(s);
    if (str.length > inner) return " " + str.slice(0, inner) + " ";
    const pad = inner - str.length;
    if (a === "r") return " " + " ".repeat(pad) + str + " ";
    if (a === "c") {
      const l = Math.floor(pad / 2);
      const r = pad - l;
      return " " + " ".repeat(l) + str + " ".repeat(r) + " ";
    }
    return " " + str + " ".repeat(pad) + " ";
  }

  function rowLine(left: string, mid: string, right: string, fill: string): string {
    return left + widths.map((w) => fill.repeat(w)).join(mid) + right;
  }

  function dataLine(cells: string[]): string {
    return "│" + cells.map((c, i) => cell(c, widths[i], align[i])).join("│") + "│";
  }

  const top = rowLine("┌", "┬", "┐", "─");
  const headerLine = dataLine(headers);
  const sep = rowLine("├", "┼", "┤", "─");
  const dataLines = rows.map((r) => dataLine(r));
  const bot = rowLine("└", "┴", "┘", "─");

  return [top, headerLine, sep, ...dataLines, bot].join("\n");
}

/** Generate the OWNER'S analysis report (.txt) — includes revenue + profit + links. */
export function buildResellerAnalysisReport(
  resellerName: string,
  periodLabel: string,
  generatedLabel: string,
  sales: SaleRow[]
): string {
  const totalUnits = sales.reduce((s, x) => s + x.quantity, 0);
  const totalRevenue = sales.reduce((s, x) => s + x.revenue, 0);
  const totalProfit = sales.reduce((s, x) => s + x.profit, 0);
  const paidCount = sales.filter((s) => s.paymentStatus === "done").length;
  const avgPrice = totalUnits > 0 ? Math.round(totalRevenue / totalUnits) : 0;

  const banner = buildReportBanner(
    `💎 RESELLER ANALYSIS — ${resellerName}`,
    `📊 Period: ${periodLabel}`
  );

  const summaryCard = buildInfoCard([
    ["Total Units:    ", String(totalUnits)],
    ["Total Revenue:  ", formatPKR(totalRevenue)],
    ["Total Profit:   ", formatPKR(totalProfit)],
    ["Paid:           ", `${paidCount}/${sales.length}`],
    ["Avg Price:      ", `${formatPKR(avgPrice)}/unit`],
  ]);

  // Table WITHOUT link column — links shown on separate lines below each row
  const widths = [5, 19, 6, 9, 13, 13, 10];
  const aligns: ("l" | "r" | "c")[] = ["r", "l", "r", "r", "r", "r", "l"];
  const headers = ["#", "Date (PKT)", "Qty", "Price", "Revenue", "Profit", "Payment"];
  const rows = sales.map((s, i) => {
    const d = new Date(s.date);
    const dateStr = d.toLocaleDateString("en-US", { timeZone: "Asia/Karachi", month: "short", day: "numeric" }) +
      ", " + d.toLocaleTimeString("en-US", { timeZone: "Asia/Karachi", hour: "numeric", minute: "2-digit" });
    return [
      String(i + 1),
      dateStr,
      String(s.quantity),
      String(s.pricePerUnit),
      formatPKR(s.revenue),
      formatPKR(s.profit),
      s.paymentStatus === "done" ? "Done" : "Pending",
    ];
  });
  const table = buildTable(headers, rows, widths, aligns);

  // Build full link list — each link on its own line, NOT truncated
  const linkLines: string[] = ["", "🔗 ACTIVATION LINKS", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"];
  sales.forEach((s, i) => {
    if (s.geminiLink && s.geminiLink.length > 0) {
      linkLines.push(`#${i + 1}: ${s.geminiLink}`);
    } else {
      linkLines.push(`#${i + 1}: (no link)`);
    }
  });

  return [
    banner,
    "",
    `  Generated: ${generatedLabel}`,
    "",
    summaryCard,
    "",
    table,
    "",
    linkLines.join("\n"),
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "💡 OWNER'S COPY — includes revenue, profit & full links",
  ].join("\n");
}

/** Generate the reseller's share copy (.txt) — NO revenue/profit, WITH links. */
export function buildResellerShareReport(
  resellerName: string,
  periodLabel: string,
  generatedLabel: string,
  sales: SaleRow[]
): string {
  const totalUnits = sales.reduce((s, x) => s + x.quantity, 0);
  const paidCount = sales.filter((s) => s.paymentStatus === "done").length;

  const banner = buildReportBanner(
    `💎 UNITS RECORD — ${resellerName}`,
    `📊 Period: ${periodLabel}`
  );

  const summaryCard = buildInfoCard([
    ["Total Units:    ", String(totalUnits)],
    ["Paid:           ", `${paidCount}/${sales.length}`],
  ]);

  // Table WITHOUT link column — links shown on separate lines below each row
  const widths = [5, 19, 6, 9, 10];
  const aligns: ("l" | "r" | "c")[] = ["r", "l", "r", "r", "l"];
  const headers = ["#", "Date (PKT)", "Qty", "Price", "Payment"];
  const rows = sales.map((s, i) => {
    const d = new Date(s.date);
    const dateStr = d.toLocaleDateString("en-US", { timeZone: "Asia/Karachi", month: "short", day: "numeric" }) +
      ", " + d.toLocaleTimeString("en-US", { timeZone: "Asia/Karachi", hour: "numeric", minute: "2-digit" });
    return [
      String(i + 1),
      dateStr,
      String(s.quantity),
      String(s.pricePerUnit),
      s.paymentStatus === "done" ? "Done" : "Pending",
    ];
  });
  const table = buildTable(headers, rows, widths, aligns);

  // Build full link list — each link on its own line, NOT truncated
  const linkLines: string[] = ["", "🔗 ACTIVATION LINKS", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"];
  sales.forEach((s, i) => {
    if (s.geminiLink && s.geminiLink.length > 0) {
      linkLines.push(`#${i + 1}: ${s.geminiLink}`);
    } else {
      linkLines.push(`#${i + 1}: (no link)`);
    }
  });

  return [
    banner,
    "",
    `  Generated: ${generatedLabel}`,
    "",
    summaryCard,
    "",
    table,
    "",
    linkLines.join("\n"),
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "💡 This report can be shared with the reseller",
  ].join("\n");
}

