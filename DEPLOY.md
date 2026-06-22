# 🚀 Deployment Guide — Vercel + Supabase

## Step 1: Run SQL in Supabase
1. Go to your Supabase project: https://supabase.com/dashboard/project/tctzewjuxismdebsqiwh
2. Click "SQL Editor" on the left sidebar
3. Click "New Query"
4. Paste the entire contents of `supabase-schema.sql`
5. Click "Run"
6. You should see "Success. No rows returned"

## Step 2: Push Code to GitHub
```bash
git init
git add .
git commit -m "Gemini Sales Tracker - production ready"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/gemini-tracker.git
git push -u origin main
```

## Step 3: Deploy to Vercel
1. Go to https://vercel.com/dashboard
2. Click "New Project"
3. Import your `gemini-tracker` repo from GitHub
4. Add Environment Variables:
   - DATABASE_URL = postgresql://postgres:[YOUR-PASSWORD]@db.tctzewjuxismdebsqiwh.supabase.co:5432/postgres
   - TELEGRAM_BOT_TOKEN = 8992554756:AAHIdtvD7caRbnO8ybQtJSJNTNuT1cXJIx8
   - TELEGRAM_CHAT_ID = 7281195843
5. Click "Deploy"
6. Wait 2-3 minutes for build to complete
7. Copy your Vercel URL (e.g. https://gemini-tracker.vercel.app)

## Step 4: Set Telegram Webhook
```bash
curl "https://api.telegram.org/bot8992554756:AAHIdtvD7caRbnO8ybQtJSJNTNuT1cXJIx8/setWebhook?url=https://YOUR-VERCEL-URL.vercel.app/api/telegram/webhook"
```

## Step 5: Test
- Open your Vercel URL in browser → dashboard should load
- Send /help to @salessstrackerbot in Telegram → should respond
- Send /new → log a sale → should appear on dashboard
