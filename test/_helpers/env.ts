// Build a fake Env for handler-level unit tests. Pairs with freshTestDb().
//
// The Env produced here is the same shape as src/index.ts:Env, but uses our
// node:sqlite-backed D1 shim and stub KV. Handlers are invoked directly,
// bypassing the Worker fetch dispatcher.

import { freshTestDb, type D1Like } from "./sqlite.js";
import { bytesToBase64 } from "../../src/crypto/hmac.js";
import { hmacSha256Hex } from "../../src/crypto/hmac.js";
import { makeInMemoryKv, type KVLike } from "./kv.js";

export interface FakeEnv {
  DB: unknown;
  OAUTH_KV: KVLike;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  AES_MASTER_KEY: string;
  HMAC_PEPPER: string;
  OPERATOR_TOKEN_HMAC: string;
  PUBLIC_BASE_URL: string;
  // Tests get access to the raw values they set up.
  _operatorToken: string;
  _db: D1Like;
}

export async function makeFakeEnv(
  opts: { operatorToken?: string } = {},
): Promise<FakeEnv> {
  const db = await freshTestDb();
  const pepper = bytesToBase64(new Uint8Array(32).fill(0xab));
  const masterKey = bytesToBase64(new Uint8Array(32).fill(0xcd));
  const operatorToken = opts.operatorToken ?? "operator-token-test-only-1234567890";
  const operatorTokenHmac = await hmacSha256Hex(pepper, operatorToken);
  return {
    DB: db,
    OAUTH_KV: makeInMemoryKv(),
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    AES_MASTER_KEY: masterKey,
    HMAC_PEPPER: pepper,
    OPERATOR_TOKEN_HMAC: operatorTokenHmac,
    PUBLIC_BASE_URL: "https://example.test",
    _operatorToken: operatorToken,
    _db: db,
  };
}

