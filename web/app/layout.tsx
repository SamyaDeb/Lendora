import type {Metadata, Viewport} from "next";
import {headers} from "next/headers";
import {Instrument_Sans} from "next/font/google";
import "./globals.css";
import {Providers} from "./providers";
import {Header} from "@/components/shell/Header";
import {Footer} from "@/components/shell/Footer";
import {OnboardingModal} from "@/components/shell/OnboardingModal";

/** Every page shows live data (APP-R7) and reads the region header (APP-R2): render per request, never at build. */
export const dynamic = "force-dynamic";

/** The landing page's typeface, self-hosted by next/font (no third-party request). */
const instrument = Instrument_Sans({subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-instrument", display: "swap"});

export const metadata: Metadata = {
  title: {default: "Lendora", template: "%s · Lendora"},
  description: "Lend and borrow Stock Tokens on Robinhood Chain. Live short interest for tokenized equities.",
};
export const viewport: Viewport = {width: "device-width", initialScale: 1, themeColor: "#0b0a18", colorScheme: "dark"};

export default async function RootLayout({children}: {children: React.ReactNode}) {
  const restricted = (await headers()).get("x-stockline-restricted") === "1";
  return (
    <html lang="en" className={instrument.variable} data-session="open">
      <body className="flex min-h-screen flex-col">
        <div className="shell-bg" aria-hidden />
        <a href="#main" className="sr-only rounded-sm bg-overlay p-3 focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[80]">
          Skip to content
        </a>
        <Providers restricted={restricted}>
          <Header />
          <main id="main" className="mx-auto w-full max-w-[1320px] flex-1 px-4 pb-10 pt-6 md:px-6 md:pt-8">
            {children}
          </main>
          <Footer />
          <OnboardingModal />
        </Providers>
      </body>
    </html>
  );
}
