import {notFound} from "next/navigation";
import {TICKERS} from "@/lib/env";
import {ShortPanel} from "@/components/ShortPanel";

export async function generateMetadata({params}: {params: Promise<{symbol: string}>}) {
  return {title: `Borrow ${(await params).symbol.toUpperCase()}`};
}

export default async function ShortPage({params}: {params: Promise<{symbol: string}>}) {
  const symbol = (await params).symbol.toUpperCase();
  if (!TICKERS.includes(symbol)) notFound();
  return <ShortPanel symbol={symbol} />;
}
