/**
 * Auth helper for route tests. JwtService.validateToken reads the session from CacheService, which
 * is the one seam, so Redis is replaced with an in-memory map. Tokens are real (RS256, the test key).
 *
 * Import this file BEFORE anything that creates a JwtService, so the fake is in place first.
 */
import { CacheService } from "@/services/cache.service";

const store = new Map<string, unknown>();

const fakeCache = {
	get: async (key: string) => (store.has(key) ? store.get(key) : null),
	set: async (key: string, value: unknown) => {
		store.set(key, JSON.parse(JSON.stringify(value)));
	},
	delete: async (key: string) => {
		store.delete(key);
	},
	deleteMany: async (keys: string[]) => {
		for (const key of keys) store.delete(key);
	},
	redis: {
		get: async () => null,
		set: async () => "OK",
		del: async () => 0,
	},
	getConnectionOptions: () => ({ host: "127.0.0.1", port: 6379 }),
};

/* @info - The singleton slot is private; the fake goes straight in. */
(CacheService as unknown as { instance: unknown }).instance = fakeCache;

export interface SessionOptions {
	/** @info - What the cached claim says. Left stale on purpose in one test (D25). */
	emailVerified?: boolean;
	/** @info - Leave the id out to prove a cache entry without one gets 401 (D24). */
	omitId?: boolean;
}

/** @info - Writes the cache entry validateToken reads and returns the Authorization header. */
export const sessionFor = async (
	userId: number,
	options: SessionOptions = {},
): Promise<{ Authorization: string }> => {
	const { JwtService } = await import("@/services/jwt.service");
	const authId = `auth:${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	await fakeCache.set(authId, {
		...(options.omitId ? {} : { id: userId }),
		authId,
		emailVerified: options.emailVerified ?? true,
		action: "authenticate",
		isAuthenticated: true,
	});
	const token = JwtService.getInstance().generateToken(authId);
	return { Authorization: `Bearer ${token}` };
};
