import {ButtonLink, EmptyState} from "@/components/ui";

export default function NotFound() {
  return (
    <EmptyState title="This page doesn't exist" icon="search" className="mx-auto max-w-md" action={<ButtonLink href="/" variant="secondary">Back to markets</ButtonLink>}>
      The link may be old. Stock pages live at /stock/TICKER.
    </EmptyState>
  );
}
