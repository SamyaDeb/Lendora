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

/** The response for an error thrown by a route: its HttpError status, 503 while the indexer rebuilds, else a bare 500. */
export function errorStatus(err: unknown): {status: 400 | 401 | 403 | 404 | 409 | 500 | 503; error: string; retryAfter?: number} {
  if (err instanceof HttpError) return {status: err.status, error: err.message};
  if (REBUILDING.has(String((err as {code?: unknown})?.code))) return {status: 503, error: "the indexer is rebuilding its views; retry shortly", retryAfter: 30};
  return {status: 500, error: "internal error"};
}
