import {startWebStack} from "./stack";

/** Starts the local product once; workers read the URLs from env. Returns the teardown. */
export default async function globalSetup() {
  const w = await startWebStack();
  process.env.E2E_BASE_URL = w.baseUrl;
  process.env.E2E_RPC_URL = w.stack.anvil.url;
  process.env.E2E_API_URL = w.stack.api.url;
  return async () => w.close();
}
