/**
 * OFF-15: request bodies on the web server's own routes are small JSON (an address, a signature, a terms version,
 * alert settings, an analytics event). Anything bigger is refused before it is buffered, parsed or forwarded.
 */
export const MAX_BODY_BYTES = 16 * 1024;

/** The body as text, or null when it is over `max` bytes (by content-length, or counted while streaming). */
export async function readBody(req: Request, max = MAX_BODY_BYTES): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export const tooLarge = () => Response.json({error: `request body over ${MAX_BODY_BYTES} bytes`}, {status: 413});
