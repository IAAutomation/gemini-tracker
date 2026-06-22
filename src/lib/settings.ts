import { db } from "./db";

const DEFAULTS: Record<string, string> = {
  costPerUnit: "250",
  allowedPrices: "400,500,550,600",
  knownResellers: "Mehroz,Salaar,Zain,Fahad",
  adminPassword: "Iht@Admin",
  autoReminderEnabled: "true",
  autoReminderTime: "22:00",
  autoReminderLastSent: "",
  botName: "💎 Gemini Sales Tracker",
  welcomeMessage: "",
  dailyAutoPushEnabled: "false",
  dailyAutoPushTime: "20:00",
  currency: "PKR",
  timezone: "Asia/Karachi",
  refreshInterval: "4",
};

export async function getSetting(key: string): Promise<string> {
  const row = await db.setting.findUnique({ where: { key } });
  return row?.value ?? DEFAULTS[key] ?? "";
}

export async function getSettings(keys: string[]): Promise<Record<string, string>> {
  const rows = await db.setting.findMany({ where: { key: { in: keys } } });
  const result: Record<string, string> = {};
  for (const k of keys) {
    const row = rows.find((r) => r.key === k);
    result[k] = row?.value ?? DEFAULTS[k] ?? "";
  }
  return result;
}

export async function getAllSettings(): Promise<Record<string, string>> {
  const rows = await db.setting.findMany();
  const result: Record<string, string> = { ...DEFAULTS };
  for (const r of rows) {
    result[r.key] = r.value;
  }
  return result;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

export async function setSettings(entries: Record<string, string>): Promise<void> {
  for (const [key, value] of Object.entries(entries)) {
    await db.setting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }
}

export async function getTypedSettings() {
  const s = await getAllSettings();
  return {
    costPerUnit: Number(s.costPerUnit),
    allowedPrices: s.allowedPrices.split(",").map(Number).filter(Boolean),
    knownResellers: s.knownResellers.split(",").filter(Boolean),
    adminPassword: s.adminPassword,
    autoReminderEnabled: s.autoReminderEnabled === "true",
    autoReminderTime: s.autoReminderTime,
    autoReminderLastSent: s.autoReminderLastSent,
    botName: s.botName,
    welcomeMessage: s.welcomeMessage,
    dailyAutoPushEnabled: s.dailyAutoPushEnabled === "true",
    dailyAutoPushTime: s.dailyAutoPushTime,
    currency: s.currency,
    timezone: s.timezone,
    refreshInterval: Number(s.refreshInterval),
  };
}

export const SETTING_DEFS: {
  key: string;
  label: string;
  description: string;
  type: "text" | "number" | "boolean" | "comma_list" | "time" | "password";
}[] = [
  { key: "costPerUnit", label: "Cost per Unit", description: "Your cost per Gemini unit (PKR). Profit = (price - cost) × qty.", type: "number" },
  { key: "allowedPrices", label: "Allowed Prices", description: "Comma-separated preset prices shown as buttons in /new.", type: "comma_list" },
  { key: "knownResellers", label: "Known Resellers", description: "Comma-separated reseller names shown as buttons in /new.", type: "comma_list" },
  { key: "adminPassword", label: "Admin Password", description: "Password required to access /admin panel.", type: "password" },
  { key: "autoReminderEnabled", label: "Auto Reminder", description: "Send pending payment reminders automatically.", type: "boolean" },
  { key: "autoReminderTime", label: "Reminder Time", description: "Time (PKT, 24h) to send pending payment reminders.", type: "time" },
  { key: "dailyAutoPushEnabled", label: "Daily Auto-Push", description: "Automatically send daily stats summary.", type: "boolean" },
  { key: "dailyAutoPushTime", label: "Daily Push Time", description: "Time (PKT, 24h) to auto-send daily summary.", type: "time" },
  { key: "botName", label: "Bot Display Name", description: "The bot's display name (shown in Telegram).", type: "text" },
  { key: "currency", label: "Currency", description: "Currency suffix for all amounts.", type: "text" },
  { key: "timezone", label: "Timezone", description: "IANA timezone for all date calculations.", type: "text" },
  { key: "refreshInterval", label: "Refresh Interval", description: "Dashboard auto-refresh interval (seconds).", type: "number" },
];
