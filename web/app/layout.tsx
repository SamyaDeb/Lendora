import type {Metadata, Viewport} from "next";
import {headers} from "next/headers";
import "./globals.css";
import {Providers} from "./providers";
import {Header} from "@/components/Header";
import {Footer} from "@/components/Footer";

/** Every page shows live data (APP-R7) and reads the region header (APP-R2): render per request, never at build. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: {default: "Stockline", template: "%s · Stockline"},
  description: "Lend and borrow Stock Tokens on Robinhood Chain. Live short interest for tokenized equities.",
};
export const viewport: Viewport = {width: "device-width", initialScale: 1, themeColor: "#0f6e5c"};

export default async function RootLayout({children}: {children: React.ReactNode}) {
  const restricted = (await headers()).get("x-stockline-restricted") === "1";
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-[var(--color-surface)] focus:p-2">
          Skip to content
        </a>
        <Providers restricted={restricted}>
          <Header />
          <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
            {children}
          </main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
