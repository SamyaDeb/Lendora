import Link from "next/link";
import {ButtonLink, Icon} from "@/components/ui";

export const metadata = {title: "Not available in your region"};

/** APP-R2 block page. Exits stay reachable. */
export default function RestrictedPage() {
  return (
    <div className="panel mx-auto max-w-xl space-y-4 p-7" data-testid="restricted">
      <span className="grid size-11 place-items-center rounded-sm bg-danger-soft text-danger">
        <Icon name="lock" size={20} />
      </span>
      <h1 className="t-title">Lendora is not available in your region</h1>
      <p className="text-[15px] leading-relaxed text-dim">Stock Tokens and Lendora are not offered in the United States, Canada, the United Kingdom, Switzerland, the United Arab Emirates or sanctioned jurisdictions.</p>
      <p className="text-[15px] leading-relaxed text-dim">If you already have a position, you can always exit: repay, close and withdraw from your portfolio.</p>
      <div className="flex flex-wrap items-center gap-4 pt-1">
        <ButtonLink href="/portfolio">Go to my portfolio</ButtonLink>
        <Link href="/terms" className="text-[14px] text-accent-text hover:underline">
          Terms and risks
        </Link>
      </div>
    </div>
  );
}
