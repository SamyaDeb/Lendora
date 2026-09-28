import type {Metadata} from "next";
import {Instrument_Sans} from "next/font/google";
import "./landing.css";
import {ToastProvider} from "@/components/landing/Toast";
import SmoothScroll from "@/components/landing/SmoothScroll";
import ScrollReveal from "@/components/landing/ScrollReveal";

export const metadata: Metadata = {
  title: "Lendora — Lend and borrow Stock Tokens",
  description: "Lend and borrow Stock Tokens on Robinhood Chain. Live short interest for tokenized equities.",
};

/** Same typeface as the app, self-hosted by next/font (no third-party font request). */
const instrument = Instrument_Sans({subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-instrument", display: "swap"});

export default function MarketingLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" className={instrument.variable}>
      <body>
        <SmoothScroll />
        <ScrollReveal />
        <ToastProvider>{children}</ToastProvider>
        <noscript>
          <style>{`[data-reveal="up"],.coin-grid[data-reveal] .mcoin{opacity:1!important}.rw>span{translate:none!important}.sw{opacity:1!important}`}</style>
        </noscript>
      </body>
    </html>
  );
}
