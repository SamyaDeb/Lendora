export const metadata = {title: "Terms and risk disclosure"};

/** APP-R10: the current terms, as served by the compliance service (the wallet signs their hash). */
export default async function TermsPage() {
  const url = process.env.COMPLIANCE_URL ?? "http://127.0.0.1:42071";
  const t = (await fetch(`${url}/v1/compliance/terms`, {next: {revalidate: 300}}).then((r) => r.json()).catch(() => undefined)) as {version: string; hash: string; text: string} | undefined;
  return (
    <article className="card mx-auto max-w-3xl space-y-3 p-6">
      {t ? (
        <>
          <pre className="whitespace-pre-wrap font-[var(--font-sans)] text-sm leading-6">{t.text}</pre>
          <p className="text-xs text-[var(--color-muted)]">
            Version {t.version} · SHA-256 {t.hash}
          </p>
        </>
      ) : (
        <p>The terms are temporarily unavailable. Please try again shortly.</p>
      )}
    </article>
  );
}
