export const metadata = {title: "Terms and risk disclosure"};

/** APP-R10: the current terms, as served by the compliance service (the wallet signs their hash). */
export default async function TermsPage() {
  const url = process.env.COMPLIANCE_URL ?? "http://127.0.0.1:42071";
  const t = (await fetch(`${url}/v1/compliance/terms`, {next: {revalidate: 300}}).then((r) => r.json()).catch(() => undefined)) as {version: string; hash: string; text: string} | undefined;
  return (
    <article className="mx-auto max-w-3xl space-y-5">
      <h1 className="t-display">Terms and risks</h1>
      <div className="panel p-6">
        {t ? (
          <>
            <pre className="whitespace-pre-wrap font-sans text-[15px] leading-7 text-dim">{t.text}</pre>
            <p className="num mt-5 border-t border-line pt-4 text-[12.5px] text-muted">
              {/* T19: the 66-character hash wraps; unbroken, it widened the page to 514 px on a 390 px phone. */}
              Version {t.version} · SHA-256 <span className="break-all">{t.hash}</span>
            </p>
          </>
        ) : (
          <p className="text-dim">The terms didn&apos;t load: the compliance service didn&apos;t respond. Try again in a minute.</p>
        )}
      </div>
    </article>
  );
}
