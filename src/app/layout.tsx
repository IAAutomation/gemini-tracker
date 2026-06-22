import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Gemini Sales Tracker — Reseller Dashboard",
  description:
    "Auto-track your Gemini reseller sales, revenue, and profit with a Telegram bot + live dashboard.",
  keywords: ["Gemini", "reseller", "sales", "tracker", "Telegram bot", "dashboard"],
  icons: {
    icon: "/logo.svg",
  },
};

// Desktop viewport — even on phones, force the dashboard to render at desktop width.
// This makes the Mini App look like a proper desktop dashboard inside Telegram.
export const viewport: Viewport = {
  width: 1280,
  initialScale: 0.3,
  maximumScale: 1.0,
  userScalable: true,
  themeColor: "#1F2E1E",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Telegram Mini App SDK — loaded only when inside Telegram's WebView */}
        <script
          src="https://telegram.org/js/telegram-web-app.js"
          async
          strategy="beforeInteractive"
        />
        {/* Force desktop-width rendering on mobile devices.
            Combined with the viewport meta above, this makes the dashboard
            show at 1280px width even on a phone inside Telegram's Mini App. */}
        <style dangerouslySetInnerHTML={{ __html: `
          /* Desktop-first rendering: never shrink below desktop layout */
          html, body {
            min-width: 1280px !important;
            width: 1280px !important;
            overflow-x: auto;
          }
          /* When inside Telegram Mini App, expand to full viewport */
          @media (min-width: 1280px) {
            html, body {
              min-width: 100% !important;
              width: 100% !important;
            }
          }
        `}} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
        style={{ backgroundColor: "#E4FD97", color: "#2D3E2C" }}
      >
        {children}
        <Toaster />
        {/* Telegram Mini App init script — runs only inside Telegram */}
        <script
          dangerouslySetInnerHTML={{ __html: `
            (function() {
              if (window.Telegram && window.Telegram.WebApp) {
                var tg = window.Telegram.WebApp;
                tg.ready();
                tg.expand();
                // Set the header color to match our forest theme
                try { tg.setHeaderColor('#1F2E1E'); } catch (e) {}
                try { tg.setBackgroundColor('#E4FD97'); } catch (e) {}
                // Disable vertical swipes (so user doesn't accidentally close the app)
                try { tg.disableVerticalSwipes(); } catch (e) {}
                // Show the main button (closing it = the user is just viewing)
                try { tg.MainButton.hide(); } catch (e) {}
                console.log('[Telegram Mini App] Ready, expanded, themed.');
              }
            })();
          `}}
        />
      </body>
    </html>
  );
}
