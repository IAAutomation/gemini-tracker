"use client";

import { motion } from "framer-motion";
import { Sale, formatDateTime, formatPKR } from "@/lib/types";

type Props = {
  sales: Sale[];
};

export function SalesTable({ sales }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.36 }}
      className="rounded-2xl p-6 shadow-lg relative overflow-hidden"
      style={{
        background: "linear-gradient(135deg, #15211A 0%, #1F2E1E 100%)",
        color: "#F0FFB0",
        border: "1px solid #4A6B47",
      }}
    >
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-bold" style={{ color: "#F0FFB0" }}>
            Recent Sales
          </h2>
          <p className="text-xs" style={{ color: "#C9E66B" }}>
            Latest {sales.length} transactions in selected range
          </p>
        </div>
        <div
          className="rounded-lg px-3 py-1.5 text-xs font-semibold"
          style={{
            background: "rgba(244, 201, 93, 0.15)",
            color: "#F4C95D",
            border: "1px solid rgba(244, 201, 93, 0.3)",
          }}
        >
          {sales.length} rows
        </div>
      </div>

      <div
        className="max-h-96 overflow-y-auto rounded-xl"
        style={{
          background: "rgba(228, 253, 151, 0.03)",
          border: "1px solid rgba(228, 253, 151, 0.08)",
        }}
      >
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10" style={{ background: "#15211A" }}>
            <tr style={{ borderBottom: "2px solid #4A6B47" }}>
              <Th>Date</Th>
              <Th>Reseller</Th>
              <Th className="text-right">Units</Th>
              <Th className="text-right">Price</Th>
              <Th className="text-right">Revenue</Th>
              <Th className="text-right">Profit</Th>
              <Th className="text-center">Payment</Th>
            </tr>
          </thead>
          <tbody>
            {sales.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="text-center py-12 font-medium"
                  style={{ color: "#C9E66B" }}
                >
                  No sales in this range. Send <code style={{ color: "#F4C95D" }}>/new</code> in Telegram to log one.
                </td>
              </tr>
            ) : (
              sales.map((s, i) => {
                const paid = s.paymentStatus === "done";
                const rowBg = i % 2 === 0
                  ? "rgba(228, 253, 151, 0.04)"
                  : "rgba(228, 253, 151, 0.07)";
                return (
                  <motion.tr
                    key={s.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.03 * Math.min(i, 10) }}
                    style={{
                      background: rowBg,
                      borderBottom: "1px solid rgba(228, 253, 151, 0.06)",
                    }}
                  >
                    <Td style={{ color: "#C9E66B", fontSize: "12px" }}>{formatDateTime(s.date)}</Td>
                    <Td className="font-bold" style={{ color: "#F0FFB0" }}>
                      {s.resellerName}
                    </Td>
                    <Td className="text-right font-semibold" style={{ color: "#F0FFB0" }}>
                      {s.quantity}
                    </Td>
                    <Td className="text-right" style={{ color: "#C9E66B" }}>
                      {s.pricePerUnit}
                    </Td>
                    <Td className="text-right font-semibold" style={{ color: "#F0FFB0" }}>
                      {formatPKR(s.revenue)}
                    </Td>
                    <Td className="text-right font-bold" style={{ color: "#F4C95D" }}>
                      {formatPKR(s.profit)}
                    </Td>
                    <Td className="text-center">
                      <span
                        className="inline-block rounded-full px-2.5 py-1 text-xs font-bold"
                        style={{
                          background: paid
                            ? "linear-gradient(135deg, #F4C95D 0%, #D9A441 100%)"
                            : "rgba(107, 142, 90, 0.3)",
                          color: paid ? "#15211A" : "#F0FFB0",
                          border: paid
                            ? "1px solid #D9A441"
                            : "1px solid rgba(107, 142, 90, 0.5)",
                          boxShadow: paid ? "0 2px 6px rgba(244, 201, 93, 0.3)" : "none",
                        }}
                      >
                        {paid ? "💰 Done" : "⏳ Pending"}
                      </span>
                    </Td>
                  </motion.tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </motion.div>
  );
}

function Th({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wider ${className}`}
      style={{ color: "#F4C95D" }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className = "",
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <td className={`px-4 py-3 ${className}`} style={style}>
      {children}
    </td>
  );
}
