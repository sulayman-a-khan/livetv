import type { Metadata } from "next";
import "./globals.css";
import Header from "@/components/Header";
import AdManager from "@/components/AdManager";
import { Tv, ShieldCheck } from "lucide-react";

export const metadata: Metadata = {
  title: "SoluPlay - Automated Production Live Streaming Platform",
  description: "Watch 24/7 Live Sports, Cricket, Football, News and Entertainment streams with Smart 5-second Auto-Failover mirror links.",
  keywords: ["SoluPlay", "Live TV", "Cricket Live", "Live Sports", "Football Stream", "Automated Streaming"],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-dark-bg text-slate-100 font-sans antialiased min-h-screen flex flex-col justify-between">
        <div className="flex-1 min-h-0 flex flex-col">
          <AdManager />
          {children}
        </div>

      </body>
    </html>
  );
}
