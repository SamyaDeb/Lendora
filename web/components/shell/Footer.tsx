import Link from "next/link";
import {API_URL} from "@/lib/env";

/** APP-R10 / CP-R7: the notice on every page. */
export function Footer() {
  return (
    <footer className="mt-16 border-t border-line">
      <div className="mx-auto flex max-w-[1320px] flex-col gap-4 px-4 py-8 text-[13px] text-muted md:flex-row md:items-start md:justify-between md:px-6">
        <p className="max-w-2xl leading-relaxed">
          Not an offer of securities and not investment advice. Rates and APYs are variable. Borrowed positions can be liquidated. Not available in the United States, Canada, the United Kingdom, Switzerland, the UAE or sanctioned
          regions.
        </p>
        <nav aria-label="Legal and resources" className="flex shrink-0 flex-wrap gap-x-5 gap-y-2">
          <Link href="/terms" className="hover:text-fg hover:underline">
            Terms and risks
          </Link>
          <Link href="/status" className="hover:text-fg hover:underline">
            Status
          </Link>
          <a href={`${API_URL}/v1/openapi.json`} className="hover:text-fg hover:underline">
            API docs
          </a>
        </nav>
      </div>
    </footer>
  );
}
