/**
 * Shared types for the dashboard.
 */

export type Range = "today" | "week" | "month" | "year" | "all";

export type Sale = {
  id: string;
  date: string;
  resellerName: string;
  quantity: number;
  pricePerUnit: number;
  revenue: number;
  profit: number;
  paymentStatus: "processing" | "done";
};

export type TodaySummary = {
  date: string;
  range?: Range;
  total_units: number;
  total_revenue: number;
  total_profit: number;
  avg_price: number;
  top_reseller: { name: string; units: number } | null;
  breakdown: {
    reseller: string;
    units: number;
    price: number;
    revenue: number;
    profit: number;
    sales?: number;
  }[];
};

export type TrendPoint = {
  date: string;
  label?: string;
  units: number;
  revenue: number;
  profit: number;
};

/** Format a number as PKR currency. */
export function formatPKR(amount: number): string {
  return `${amount.toLocaleString("en-PK")} PKR`;
}

/** Format an ISO date string as e.g. "Jun 21" in PKT (Peshawar time). */
export function formatShortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    timeZone: "Asia/Karachi",
    month: "short",
    day: "numeric",
  });
}

/** Format an ISO date string as e.g. "Jun 21, 6:38 PM" in PKT (Peshawar time). */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleDateString("en-US", {
      timeZone: "Asia/Karachi",
      month: "short",
      day: "numeric",
    }) +
    ", " +
    d.toLocaleTimeString("en-US", {
      timeZone: "Asia/Karachi",
      hour: "numeric",
      minute: "2-digit",
    })
  );
}
