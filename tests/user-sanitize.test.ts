import { describe, expect, it } from "vitest";
import { generateAuthenticatedData, sanitizeUser } from "@/helpers/auth/auth.helpers";

/**
 * @info - A user row carries a password hash and a soft-delete marker. Both must
 * leave the process only as absent fields: these tests exist so adding a column to
 * `users` cannot leak it through a spread in a controller.
 */
const row = {
	id: 1,
	email: "someone@example.com",
	passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$abc$def",
	hash: "legacy-hash",
	deletedAt: new Date(),
	firstName: "Someone",
};

describe("sanitizeUser", () => {
	it("drops the password hash, the legacy hash and the soft-delete marker", () => {
		const clean = sanitizeUser(row);
		expect(clean).not.toHaveProperty("passwordHash");
		expect(clean).not.toHaveProperty("hash");
		expect(clean).not.toHaveProperty("deletedAt");
		expect(JSON.stringify(clean)).not.toContain("argon2");
	});

	it("keeps every field a client is allowed to read", () => {
		const clean = sanitizeUser(row);
		expect(clean.id).toBe(1);
		expect(clean.email).toBe("someone@example.com");
		expect(clean.firstName).toBe("Someone");
	});

	it("authenticated data is sanitized too", () => {
		const session = generateAuthenticatedData(row);
		expect(session).not.toHaveProperty("passwordHash");
		expect(session.isAuthenticated).toBe(true);
	});
});
