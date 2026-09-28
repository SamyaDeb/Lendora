import {redirect} from "next/navigation";

/** Moved to /stock/[ticker] (Lend / Borrow / Short in one page). Kept so old links keep working. */
export default async function Moved({params}: {params: Promise<{symbol: string}>}) {
  redirect(`/stock/${(await params).symbol.toUpperCase()}?tab=lend`);
}
