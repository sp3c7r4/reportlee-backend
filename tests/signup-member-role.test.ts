import { beforeEach, describe, expect, it, vi } from "vitest";
import { JwtAction } from "@/enums/auth/auth.enums";
import { createUserSchema, selectRoleSchema } from "@/shared/validators";

/**
 * @info - A new account is always a member. The choke points are signup (never caches a
 * role), verifyEmail (ignores any role an in-flight signup still holds in Redis) and
 * selectRole (never hands out admin). Collaborators are mocked so no Redis or Postgres opens.
 */
const h = vi.hoisted(() => ({
	store: new Map<string, unknown>(),
	userCreate: vi.fn(),
	roleCreate: vi.fn(),
	roleFindMany: vi.fn(),
	findById: vi.fn(),
	genTokens: vi.fn(),
}));

vi.mock("@/modules/user/user.repository", () => ({
	UserRepository: {
		getInstance: () => ({
			findOne: vi.fn(async () => null),
			findById: h.findById,
			create: h.userCreate,
			update: vi.fn(),
		}),
	},
}));

vi.mock("@/modules/user/user-role.repository", () => ({
	UserRoleRepository: {
		getInstance: () => ({
			create: h.roleCreate,
			findMany: h.roleFindMany,
		}),
	},
}));

vi.mock("@/modules/user/session-registry.service", () => ({
	SessionRegistryService: { getInstance: () => ({}) },
}));

vi.mock("@/services", () => ({
	CacheService: {
		getInstance: () => ({
			set: vi.fn(async (k: string, v: unknown) => {
				h.store.set(k, v);
			}),
			get: vi.fn(async (k: string) => h.store.get(k)),
			deleteMany: vi.fn(async () => undefined),
		}),
	},
	EmailQueueService: { getInstance: () => ({ add: vi.fn() }) },
	EncryptionService: {
		getInstance: () => ({
			encrypt: (v: string) => `enc:${v}`,
			decrypt: (v: string) => v.replace(/^enc:/, ""),
			hash: async (v: string) => `hash:${v}`,
		}),
	},
	JwtService: {
		getInstance: () => ({ generateToken: () => "jwt" }),
	},
}));

vi.mock("@/helpers", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/helpers")>();
	return {
		...actual,
		generateAuthTokens: h.genTokens,
		withPresignedUrl: async (v: unknown) => v,
	};
});

import { AuthService } from "@/modules/auth/auth.service";

const meta = { ipAddress: "127.0.0.1", location: "Test", userAgent: "vitest" };

describe("signup always yields a member", () => {
	beforeEach(() => {
		h.store.clear();
		vi.clearAllMocks();
		h.genTokens.mockResolvedValue({ accessToken: "a", refreshToken: "r" });
		h.userCreate.mockResolvedValue({
			id: 42,
			firstName: "Test",
			lastName: "User",
			email: "new@example.com",
		});
	});

	it("signup with role admin stores no role in the cached verify entry", async () => {
		await AuthService.getInstance().signup({
			firstName: "Test",
			lastName: "User",
			email: "new@example.com",
			password: "password123",
			role: "admin" as never,
			...meta,
		});
		const entries = [...h.store.values()] as Record<string, unknown>[];
		const verifyEntry = entries.find(
			(e) => e.action === JwtAction.VERIFY_EMAIL,
		);
		expect(verifyEntry).toBeDefined();
		expect(verifyEntry).not.toHaveProperty("role");
	});

	it("verifyEmail ignores a cached admin role and creates a member", async () => {
		h.store.set("otp:1", { otp: "enc:123456" });
		const res = await AuthService.getInstance().verifyEmail(
			{
				authId: "auth:x",
				otpId: "otp:1",
				action: JwtAction.VERIFY_EMAIL,
				firstName: "Test",
				lastName: "User",
				email: "new@example.com",
				role: "admin",
				password: "enc:password123",
			} as never,
			"123456",
		);
		expect(h.roleCreate).toHaveBeenCalledTimes(1);
		expect(h.roleCreate).toHaveBeenCalledWith({ userId: 42, role: "member" });
		expect(h.genTokens).toHaveBeenCalledWith(expect.any(String), "member");
		expect((res as { user: { roles: string[] } }).user.roles).toEqual([
			"member",
		]);
	});

	it("selectRole rejects admin with 403 and creates no row", async () => {
		h.findById.mockResolvedValue({ id: 42 });
		h.roleFindMany.mockResolvedValue([]);
		await expect(
			AuthService.getInstance().selectRole({ id: 42 } as never, "admin"),
		).rejects.toMatchObject({ status: 403 });
		expect(h.roleCreate).not.toHaveBeenCalled();
	});
});

describe("auth schemas", () => {
	it("selectRoleSchema rejects admin with a role issue", () => {
		const r = selectRoleSchema.safeParse({ role: "admin" });
		expect(r.success).toBe(false);
		if (!r.success) expect(r.error.issues[0]?.path).toEqual(["role"]);
	});

	it("selectRoleSchema accepts member", () => {
		expect(selectRoleSchema.safeParse({ role: "member" }).success).toBe(true);
	});

	it("createUserSchema accepts no role and accepts a legacy admin role", () => {
		const base = {
			firstName: "A",
			lastName: "B",
			email: "a@example.com",
			password: "password123",
		};
		expect(createUserSchema.safeParse(base).success).toBe(true);
		expect(createUserSchema.safeParse({ ...base, role: "admin" }).success).toBe(
			true,
		);
	});
});
