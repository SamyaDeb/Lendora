import {notFound} from "next/navigation";
import {TICKERS} from "@/lib/env";
import {LendPanel} from "@/components/LendPanel";

export async function generateMetadata({params}: {params: Promise<{symbol: string}>}) {
  return {title: `Lend ${(await params).symbol.toUpperCase()}`};
}

export default async function LendPage({params}: {params: Promise<{symbol: string}>}) {
  const symbol = (await params).symbol.toUpperCase();
  if (!TICKERS.includes(symbol)) notFound();
  return <LendPanel symbol={symbol} />;
}
