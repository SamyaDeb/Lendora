import Link from "next/link";

export const metadata = {title: "Not available in your region"};

/** APP-R2 block page. Exits stay reachable. */
export default function RestrictedPage() {
  return (
    <div className="card mx-auto max-w-xl space-y-3 p-6" data-testid="restricted">
      <h1 className="text-2xl font-bold">Stockline is not available in your region</h1>
      <p>Stock Tokens and Stockline are not offered in the United States, Canada, the United Kingdom, Switzerland, the United Arab Emirates or sanctioned jurisdictions.</p>
      <p>
        If you already have a position, you can always exit: repay, close and withdraw from your{" "}
        <Link href="/portfolio" className="underline">
          portfolio
        </Link>
        .
      </p>
      <p className="text-sm">
        <Link href="/terms" className="underline">
          Terms and risks
        </Link>
      </p>
    </div>
  );
}
