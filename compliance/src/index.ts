import {startCompliance} from "./server.js";

/** `pnpm --filter @stockline/compliance start` (env: .env.example). */
const c = await startCompliance();
console.log(`[compliance] on ${c.url} · signer ${c.svc.signerAddress}`);
const stop = async () => {
  await c.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
