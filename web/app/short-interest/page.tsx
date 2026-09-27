import {safe, serverApi} from "@/lib/api";
import {API_URL, TICKERS} from "@/lib/env";
import {Leaderboard} from "@/components/Leaderboard";
import {SiChart} from "@/components/SiChart";
import {WeekendPanel} from "@/components/WeekendPanel";

export const metadata = {title: "Short interest", description: "Live short interest for Stock Tokens on Robinhood Chain: borrowed shares, % of float, borrow rates, days to cover."};

export default async function ShortInterestPage() {
  const c = serverApi();
  const from = new Date(Date.now() - 400 * 86_400_000).toISOString();
  const [markets, ...histories] = await Promise.all([safe(c.markets()), ...TICKERS.map((t) => safe(c.history(t, {interval: "1h", from})))]);
  const hist = Object.fromEntries(TICKERS.map((t, i) => [t, histories[i]?.data ?? []]));
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Short interest</h1>
        <p className="text-sm text-[var(--color-muted)]">Every Stockline borrow is onchain, so short interest is live, not reported twice a month. Scope: Stockline markets only.</p>
      </div>
      <Leaderboard initial={markets} />
      <SiChart histories={hist} />
      <WeekendPanel markets={markets?.data ?? []} />
      <section className="card space-y-3 p-4" aria-labelledby="built">
        <h2 id="built" className="font-semibold">
          Built on this data
        </h2>
        <p className="text-sm">
          Free public API (60 requests/min; sign in with a wallet for a key and 600/min). Spec:{" "}
          <a className="underline" href={`${API_URL}/v1/openapi.json`}>
            OpenAPI 3.1
          </a>
          . Data as is, attribution requested.
        </p>
        <Snippet title="curl" code={`curl ${API_URL}/v1/markets/NVDA`} />
        <Snippet title="TypeScript (@stockline/sdk)" code={`import {api} from "@stockline/sdk";\nconst sl = api.createClient("${API_URL}");\nconst {data} = await sl.markets();\nconsole.log(data.map((m) => [m.symbol, m.borrowed, m.siPctFloat]));`} />
        <Snippet title="Python" code={`import requests\nm = requests.get("${API_URL}/v1/markets").json()\nfor s in m["data"]:\n    print(s["symbol"], s["borrowed"], s["borrowApr"])`} />
        <Snippet title="WebSocket" code={`const ws = new WebSocket("${API_URL.replace(/^http/, "ws")}/v1/stream");\nws.onopen = () => ws.send(JSON.stringify({channel: "market", symbol: "NVDA"}));\nws.onmessage = (e) => console.log(JSON.parse(e.data));`} />
      </section>
    </div>
  );
}

function Snippet({title, code}: {title: string; code: string}) {
  return (
    <div>
      <p className="text-xs font-semibold text-[var(--color-muted)]">{title}</p>
      <pre className="overflow-x-auto rounded-md bg-[var(--color-bg)] p-3 text-xs">
        <code>{code}</code>
      </pre>
    </div>
  );
}
