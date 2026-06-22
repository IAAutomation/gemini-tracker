-- Gemini Sales Tracker — Supabase Schema
-- Run this in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS "Sale" (
    "id" TEXT PRIMARY KEY,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resellerName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "pricePerUnit" INTEGER NOT NULL,
    "revenue" INTEGER NOT NULL,
    "profit" INTEGER NOT NULL,
    "paymentStatus" TEXT NOT NULL DEFAULT 'processing',
    "geminiLink" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "Setting" (
    "key" TEXT PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS "Sale_date_idx" ON "Sale"("date");
CREATE INDEX IF NOT EXISTS "Sale_resellerName_idx" ON "Sale"("resellerName");

-- Default settings
INSERT INTO "Setting" ("key", "value") VALUES
    ('costPerUnit', '250'),
    ('allowedPrices', '400,500,550,600'),
    ('knownResellers', 'Mehroz,Salaar,Zain,Fahad'),
    ('adminPassword', 'Iht@Admin'),
    ('autoReminderEnabled', 'true'),
    ('autoReminderTime', '22:00'),
    ('currency', 'PKR'),
    ('timezone', 'Asia/Karachi'),
    ('refreshInterval', '4')
ON CONFLICT ("key") DO NOTHING;
