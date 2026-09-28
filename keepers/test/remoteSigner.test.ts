import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {encodeFunctionData, parseTransaction, type Hex} from "viem";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import {anvil as anvilChain} from "viem/chains";
import {erc20Abi} from "@stockline/sdk";
import {startAnvil, type Anvil} from "./anvil.js";
import {loadConfig} from "../src/common/config.js";
import {remoteTxSender, senderFromConfig} from "../src/common/signer.js";

/** A fake KMS bridge: signs whatever it is sent with `key`, optionally tampering with the payload first. */
function fakeKms(key: Hex, tamper?: (tx: ReturnType<typeof parseTransaction>) => ReturnType<typeof parseTransaction>): typeof fetch {
  const account = privateKeyToAccount(key);
  return (async (_url: string, init: {body: string}) => {
    const {transaction} = JSON.parse(init.body) as {transaction: Hex};
    let tx = parseTransaction(transaction);
    if (tamper) tx = tamper(tx);
    const signedTransaction = await account.signTransaction(tx as never);
    return new Response(JSON.stringify({signedTransaction}), {status: 200});
  }) as unknown as typeof fetch;
}

/** Keeper standard (every signing keeper): remote signer path (KMS/HSM), no key in the process. */
describe("remote transaction signer (keepers, KMS bridge)", () => {
  let a: Anvil;
  const key = generatePrivateKey();
  const addr = privateKeyToAccount(key).address;
  const data = encodeFunctionData({abi: erc20Abi, functionName: "approve", args: ["0x0000000000000000000000000000000000000001", 1n]});

  beforeAll(async () => {
    a = await startAnvil();
    await a.test.setBalance({address: addr, value: 10n ** 18n});
  }, 120_000);
  afterAll(() => a?.stop());

  it("sends what the keeper built, signed remotely by the expected key", async () => {
    const s = remoteTxSender(a.client, anvilChain, "https://kms.example/sign", addr, "Bearer t", fakeKms(key));
    expect(s.kind).toBe("remote");
    const hash = await s.send(a.d.usdg, data, "approve");
    const tx = await a.client.getTransaction({hash: hash!});
    expect(tx.from.toLowerCase()).toBe(addr.toLowerCase());
    expect(tx.input).toBe(data);
  });

  it("refuses a signature from another key and a swapped payload", async () => {
    const other = remoteTxSender(a.client, anvilChain, "u", addr, undefined, fakeKms(generatePrivateKey()));
    await expect(other.send(a.d.usdg, data, "x")).rejects.toThrow(/another key/);
    const swapped = remoteTxSender(a.client, anvilChain, "u", addr, undefined, fakeKms(key, (tx) => ({...tx, to: "0x000000000000000000000000000000000000dEaD"})));
    await expect(swapped.send(a.d.usdg, data, "x")).rejects.toThrow(/different transaction/);
    const failing = remoteTxSender(a.client, anvilChain, "u", addr, undefined, (async () => new Response("no", {status: 503})) as unknown as typeof fetch);
    await expect(failing.send(a.d.usdg, data, "x")).rejects.toThrow(/remote signer 503/);
  });

  it("config: KEEPER_SIGNER=remote needs the URL and the address; unknown signers are refused", () => {
    const c = loadConfig({DEPLOYMENT_KEY: "31337", DRY_RUN: "false", KEEPER_SIGNER: "remote", KEEPER_REMOTE_SIGNER_URL: "https://kms", KEEPER_ADDRESS: addr});
    expect(c.signer).toBe("remote");
    expect(senderFromConfig(c, a.client, anvilChain).kind).toBe("remote");
    expect(() => senderFromConfig({...c, remoteSignerUrl: undefined}, a.client, anvilChain)).toThrow(/KEEPER_REMOTE_SIGNER_URL/);
    expect(() => loadConfig({DEPLOYMENT_KEY: "31337", KEEPER_SIGNER: "hsm"})).toThrow(/unknown KEEPER_SIGNER/);
  });
});
