import {createHash, randomBytes} from "node:crypto";
import type {Redis} from "ioredis";
import type {PublicClient} from "viem";
import {generateSiweNonce, parseSiweMessage, verifySiweMessage} from "viem/siwe";
import type {IndexerDb} from "./db.js";
import {HttpError as KeyError} from "./errors.js";

/**
 * Self-serve API keys (SI-R10): the wallet signs a Sign-In with Ethereum (EIP-4361) message carrying a one-time
 * nonce; the API verifies it (EOA or ERC-1271 through the RPC) and returns a key once. Only the key's SHA-256 and
 * the wallet address are stored.
 */
export interface NonceStore {
  put(nonce: string, ttlSec: number): Promise<void>;
  /** True once per nonce (consumed). */
  take(nonce: string): Promise<boolean>;
}

export class MemoryNonceStore implements NonceStore {
  private readonly m = new Map<string, number>();
  constructor(private readonly max = 10_000) {}
  async put(nonce: string, ttlSec: number) {
    // OFF-10: bounded. Expired nonces are dropped as the map grows; past `max` live ones the oldest go first.
    if (this.m.size >= this.max) {
      const now = Date.now();
      for (const [k, exp] of this.m) if (exp <= now) this.m.delete(k);
      for (const k of this.m.keys()) {
        if (this.m.size < this.max) break;
        this.m.delete(k);
      }
    }
    this.m.set(nonce, Date.now() + ttlSec * 1000);
  }
  get size() {
    return this.m.size;
  }
  async take(nonce: string) {
    const exp = this.m.get(nonce);
    this.m.delete(nonce);
    return exp !== undefined && exp > Date.now();
  }
}

export class RedisNonceStore implements NonceStore {
  constructor(private readonly redis: Redis) {}
  async put(nonce: string, ttlSec: number) {
    await this.redis.set(`lendora:siwe:${nonce}`, "1", "EX", ttlSec);
  }
  async take(nonce: string) {
    return (await this.redis.del(`lendora:siwe:${nonce}`)) === 1;
  }
}

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

export {HttpError as KeyError} from "./errors.js";

export class ApiKeys {
  constructor(
    private readonly db: IndexerDb,
    private readonly nonces: NonceStore,
    private readonly client: PublicClient,
    private readonly opts: {domain: string; chainId: number; maxPerAddress: number},
  ) {}

  async nonce(): Promise<string> {
    const n = generateSiweNonce();
    await this.nonces.put(n, 600);
    return n;
  }

  /** Verify a SIWE message + signature and issue a key. */
  async create(message: string, signature: `0x${string}`, label: string | null): Promise<{id: string; key: string; address: string}> {
    const parsed = parseSiweMessage(message);
    if (!parsed.address || !parsed.nonce) throw new KeyError(400, "malformed SIWE message");
    if (parsed.domain !== this.opts.domain) throw new KeyError(401, `SIWE domain must be ${this.opts.domain}`);
    if (parsed.chainId !== this.opts.chainId) throw new KeyError(401, `SIWE chainId must be ${this.opts.chainId}`);
    const ok = await verifySiweMessage(this.client, {message, signature, domain: this.opts.domain});
    if (!ok) throw new KeyError(401, "invalid SIWE signature or expired message");
    if (!(await this.nonces.take(parsed.nonce))) throw new KeyError(401, "unknown or used nonce");
    if ((await this.db.activeKeyCount(parsed.address)) >= this.opts.maxPerAddress) {
      throw new KeyError(409, `at most ${this.opts.maxPerAddress} active keys per address`);
    }
    const id = randomBytes(8).toString("hex");
    const key = `sk_${randomBytes(24).toString("base64url")}`;
    await this.db.insertKey(id, hashKey(key), parsed.address, label);
    return {id, key, address: parsed.address.toLowerCase()};
  }

  async resolve(key: string): Promise<{id: string; address: string} | undefined> {
    return this.db.keyByHash(hashKey(key));
  }
}
