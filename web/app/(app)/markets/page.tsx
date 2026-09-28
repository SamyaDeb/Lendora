import {MarketsBoard} from "@/components/markets/MarketsBoard";
import {safe, serverApi} from "@/lib/api";

export default async function MarketsPage() {
  const initial = await safe(serverApi().markets());
  return <MarketsBoard initial={initial} />;
}
