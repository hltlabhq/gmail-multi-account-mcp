// Minimal in-memory KV stub used in unit tests for code that touches
// @cloudflare/workers-oauth-provider. Implements only the methods the library
// (and our own code) actually call. Not exhaustive.

export interface KVLike {
  get(key: string, options?: { type?: "text" | "json" | "arrayBuffer" }): Promise<unknown>;
  put(key: string, value: string | ArrayBuffer | Uint8Array, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    keys: { name: string; expiration?: number }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

export function makeInMemoryKv(): KVLike {
  const store = new Map<string, { value: string; expiresAt?: number }>();

  function purgeExpired(): void {
    const now = Date.now();
    for (const [k, v] of store) {
      if (v.expiresAt !== undefined && v.expiresAt <= now) {
        store.delete(k);
      }
    }
  }

  return {
    async get(key, options) {
      purgeExpired();
      const v = store.get(key);
      if (!v) return null;
      const text = v.value;
      const type = options?.type ?? "text";
      if (type === "json") {
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      }
      if (type === "arrayBuffer") {
        const bytes = new TextEncoder().encode(text);
        return bytes.buffer;
      }
      return text;
    },
    async put(key, value, opts) {
      const text = typeof value === "string" ? value : new TextDecoder().decode(value);
      const expiresAt = opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : undefined;
      store.set(key, { value: text, expiresAt });
    },
    async delete(key) {
      store.delete(key);
    },
    async list(opts) {
      purgeExpired();
      const prefix = opts?.prefix ?? "";
      const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const limit = opts?.limit ?? 1000;
      const startIdx = opts?.cursor ? Math.max(0, all.indexOf(opts.cursor)) + 1 : 0;
      const slice = all.slice(startIdx, startIdx + limit);
      return {
        keys: slice.map((name) => ({ name })),
        list_complete: startIdx + slice.length >= all.length,
        cursor: startIdx + slice.length < all.length ? slice[slice.length - 1] : undefined,
      };
    },
  };
}
