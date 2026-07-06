/**
 * Redis cache with in-memory fallback.
 * Adapted from Gridlock's cache.ts — namespaced to ghost: instead of gridlock:
 */

import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_URL ?? '';

let redisClient: ReturnType<typeof createClient> | null = null;
let redisUnavailable = false;
const memCache = new Map<string, string>();
let cacheHits = 0;
let cacheMisses = 0;

export async function getRedis(): Promise<ReturnType<typeof createClient> | null> {
  if (redisClient) return redisClient;
  if (redisUnavailable || !REDIS_URL) return null;
  try {
    const client = createClient({
      url: REDIS_URL,
      socket: {
        connectTimeout: 2000,
        reconnectStrategy: () => false,
      },
    });
    client.on('error', () => {});
    await Promise.race([
      client.connect().then(() => client.ping()),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('connect timeout')), 2500)),
    ]);
    redisClient = client;
    console.log('[cache] Redis connected');
    return client;
  } catch (err) {
    redisUnavailable = true;
    console.log(`[cache] Redis unavailable (${err instanceof Error ? err.message : err}) — using in-memory`);
    return null;
  }
}

export async function cacheGet(key: string): Promise<string | null> {
  const r = await getRedis();
  if (r) return (await r.hGet('ghost:cache', key)) ?? null;
  return memCache.get(key) ?? null;
}

export async function cacheSet(key: string, value: string): Promise<void> {
  const r = await getRedis();
  if (r) {
    await r.hSet('ghost:cache', key, value);
    await r.expire('ghost:cache', 3600);
  } else {
    memCache.set(key, value);
  }
}

export async function cacheGetTracked(key: string): Promise<string | null> {
  const r = await getRedis();
  if (r) {
    const val = await r.hGet('ghost:cache', key);
    await r.incr(val ? 'ghost:cache_hits' : 'ghost:cache_misses');
    return val ?? null;
  }
  const val = memCache.get(key) ?? null;
  if (val) cacheHits++; else cacheMisses++;
  return val;
}

export async function cacheSetTtl(key: string, value: string, ttlSec = 3600): Promise<void> {
  const r = await getRedis();
  if (r) {
    await r.hSet('ghost:cache', key, value);
    await r.set(`ghost:warm:${key}`, value, { EX: ttlSec });
  } else {
    memCache.set(key, value);
  }
}

export async function cacheWarmCheck(key: string): Promise<string | null> {
  const r = await getRedis();
  if (r) return (await r.get(`ghost:warm:${key}`)) ?? null;
  return memCache.get(key) ?? null;
}

export async function getCacheStats() {
  const r = await getRedis();
  if (r) {
    const hits = Number((await r.get('ghost:cache_hits')) ?? 0);
    const misses = Number((await r.get('ghost:cache_misses')) ?? 0);
    const entries = await r.hLen('ghost:cache');
    const total = hits + misses;
    return { hits, misses, entries, hit_rate: total ? Math.round((hits / total) * 1000) / 10 : 0 };
  }
  const total = cacheHits + cacheMisses;
  return {
    hits: cacheHits, misses: cacheMisses, entries: memCache.size,
    hit_rate: total ? Math.round((cacheHits / total) * 1000) / 10 : 0,
  };
}
