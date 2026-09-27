import Link from "next/link";

/** APP-R10 / CP-R7: the notice on every page. */
export function Footer() {
  return (
    <footer className="border-t border-[var(--color-line)] bg-[var(--color-surface)]">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-5 text-sm text-[var(--color-muted)] sm:flex-row sm:items-center sm:justify-between">
        <p>
          Not an offer of securities and not investment advice. Rates and APYs are variable. Borrowed positions can be liquidated. Not available in restricted regions.
        </p>
        <nav aria-label="Legal" className="flex gap-4">
          <Link href="/terms" className="underline">
            Terms &amp; risks
          </Link>
          <Link href="/status" className="underline">
            Status
          </Link>
        </nav>
      </div>
    </footer>
  );
}
