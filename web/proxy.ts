import {NextResponse, type NextRequest} from "next/server";
import {isRestricted, restrictedListFromEnv} from "@lendora/sdk";
import {geoPlatform, staticGeo, visitorGeo} from "@/lib/complianceProxy";

/**
 * APP-R2 geo-block (Next 16 Proxy, the successor of edge middleware). Visitors from a restricted country or region
 * (CP-R1, list = packages/sdk/data/compliance.json or env) see the block page, except on the marketing landing
 * page (/) and the routes they need to exit: /portfolio (repay, close, withdraw), /terms, /status and the API
 * routes. Borrow and short also need the
 * compliance attestation (RT-R2). The country comes only from the configured platform's headers (`GEO_PLATFORM`, as
 * the compliance proxy), or `GEO_STATIC_COUNTRY` on the local testnet stack.
 */
const list = restrictedListFromEnv(process.env);
const EXIT_OK = [/^\/$/, /^\/portfolio(\/|$)/, /^\/restricted$/, /^\/terms$/, /^\/status$/, /^\/api\//];

export function proxy(req: NextRequest) {
  const platform = geoPlatform(process.env.GEO_PLATFORM);
  const {country = null, region = null} = visitorGeo(req.headers, platform, platform === "static" ? staticGeo() : undefined);
  const restricted = isRestricted({country, region: region && country && !region.includes("-") ? `${country}-${region}` : region}, list);
  if (!restricted) return NextResponse.next();
  const path = req.nextUrl.pathname;
  if (EXIT_OK.some((r) => r.test(path))) {
    const headers = new Headers(req.headers);
    headers.set("x-lendora-restricted", "1");
    return NextResponse.next({request: {headers}});
  }
  return NextResponse.rewrite(new URL("/restricted", req.url));
}

export const config = {matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"]};
