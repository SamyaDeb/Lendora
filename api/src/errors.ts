/** An error with an HTTP status, mapped by the app's `onError`. */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

/** Postgres codes for a missing view or schema: the indexer is (re)creating its views schema (a restart or reindex). */
const REBUILDING = new Set(["42P01", "3F000"]);

/** Retry-After (s) when the chain RPC fails. */
export const RPC_RETRY_AFTER = 10;

/** viem errors meaning the chain RPC didn't answer usefully (down, throttled, timed out, refused the request). */
const RPC_ERRORS = new Set(["HttpRequestError", "TimeoutError", "RpcRequestError", "UnknownRpcError", "InvalidRequestRpcError", "LimitExceededRpcError", "ResourceUnavailableRpcError", "InternalRpcError", "WebSocketRequestError", "SocketClosedError"]);

/** True when the error, or anything in its `cause` chain, is an RPC transport or provider error (not a revert). */
function rpcFailure(err: unknown): boolean {
  for (let e = err as {name?: string; cause?: unknown} | undefined, i = 0; e && i < 8; e = e.cause as typeof e, i++) if (RPC_ERRORS.has(String(e.name))) return true;
  return false;
}

/**
 * The response for an error thrown by a route: its HttpError status; 503 with Retry-After while the indexer rebuilds
 * or the chain RPC fails (T26: throttled public RPC on 46630 answered /v1/vault/* with 500s); else a bare 500.
 */
export function errorStatus(err: unknown): {status: 400 | 401 | 403 | 404 | 409 | 500 | 503; error: string; retryAfter?: number} {
  if (err instanceof HttpError) return {status: err.status, error: err.message};
  if (REBUILDING.has(String((err as {code?: unknown})?.code))) return {status: 503, error: "the indexer is rebuilding its views; retry shortly", retryAfter: 30};
  if (rpcFailure(err)) return {status: 503, error: "the chain RPC didn't answer; retry shortly", retryAfter: RPC_RETRY_AFTER};
  return {status: 500, error: "internal error"};
}
