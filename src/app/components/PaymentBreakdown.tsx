"use client";

import { motion } from "framer-motion";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { Sale } from "@/lib/types";
import { formatPKR } from "@/lib/types";

type Props = {
  sales: Sale[];
};

const PAID_COLOR = "#F4C95D";       // amber for paid
const PENDING_COLOR = "#6B8E5A";    // sage for pending

export function PaymentBreakdown({ sales }: Props) {
  const paid = sales.filter((s) => s.paymentStatus === "done");
  const pending = sales.filter((s) => s.paymentStatus !== "done");

  const paidRevenue = paid.reduce((s, x) => s + x.revenue, 0);
  const pendingRevenue = pending.reduce((s, x) => s + x.revenue, 0);

  const data = [
    { name: "Paid", value: paidRevenue, count: paid.length, color: PAID_COLOR },
    { name: "Pending", value: pendingRevenue, count: pending.length, color: PENDING_COLOR },
  ];

  const total = paidRevenue + pendingRevenue;

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.3 }}
      className="rounded-2xl p-6 shadow-lg h-full relative overflow-hidden"
      style={{
        background: "linear-gradient(135deg, #15211A 0%, #1F2E1E 100%)",
        color: "#F0FFB0",
        border: "1px solid #4A6B47",
      }}
    >
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-bold" style={{ color: "#F0FFB0" }}>
            Payment Status
          </h2>
          <p className="text-xs" style={{ color: "#C9E66B" }}>
            Revenue split — paid vs pending
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
          {paid.length + pending.length} sales
        </div>
      </div>

      {total === 0 ? (
        <div
          className="flex items-center justify-center h-64 rounded-xl text-sm font-medium"
          style={{
            background: "rgba(228, 253, 151, 0.06)",
            color: "#C9E66B",
            border: "1px dashed rgba(228, 253, 151, 0.2)",
          }}
        >
          No sales in this range.
        </div>
      ) : (
        <>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={55}
                  outerRadius={85}
                  paddingAngle={4}
                  animationDuration={800}
                  stroke="#15211A"
                  strokeWidth={3}
                >
                  {data.map((entry, i) => (
                    <Cell key={i} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    background: "#15211A",
                    border: "1px solid #4A6B47",
                    borderRadius: "12px",
                    color: "#F0FFB0",
                    fontSize: "13px",
                    boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                  }}
                  labelStyle={{ color: "#F4C95D", fontWeight: 700 }}
                  formatter={(value: number, _name, props) => [
                    `${formatPKR(value)} (${props.payload.count} sales)`,
                    props.payload.name,
                  ]}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>

          <div className="grid grid-cols-2 gap-3 mt-4">
            <div
              className="rounded-xl p-3 text-center"
              style={{
                background: "rgba(244, 201, 93, 0.18)",
                border: "1px solid rgba(244, 201, 93, 0.35)",
              }}
            >
              <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "#F4C95D" }}>
                💰 Paid
              </div>
              <div className="text-base font-black" style={{ color: "#F0FFB0" }}>
                {formatPKR(paidRevenue)}
              </div>
              <div className="text-xs font-medium" style={{ color: "#C9E66B" }}>
                {paid.length} sales
              </div>
            </div>
            <div
              className="rounded-xl p-3 text-center"
              style={{
                background: "rgba(107, 142, 90, 0.25)",
                border: "1px solid rgba(107, 142, 90, 0.45)",
              }}
            >
              <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: "#C9E66B" }}>
                ⏳ Pending
              </div>
              <div className="text-base font-black" style={{ color: "#F0FFB0" }}>
                {formatPKR(pendingRevenue)}
              </div>
              <div className="text-xs font-medium" style={{ color: "#C9E66B" }}>
                {pending.length} sales
              </div>
            </div>
          </div>
        </>
      )}
    </motion.div>
  );
}
