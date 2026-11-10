import { describe, expect, it } from "vitest";
import { REDACTED, redactLog } from "@/helpers/log-redact.helper";

/**
 * @info - Regression: the zod engine logged every validated body and response, so
 * login attempts wrote passwords to the box log in plaintext and token responses
 * wrote live JWTs. These assert the log copy is safe while still being useful.
 */
describe("redactLog", () => {
	it("masks credentials in a login-shaped payload at any depth", () => {
		const logged = redactLog({
			data: {
				email: "someone@example.com",
				password: "Secret1234!",
				nested: { refreshToken: "eyJhbGciOi..." },
			},
			success: true,
		}) as any;

		expect(logged.data.email).toBe("someone@example.com");
		expect(logged.data.password).toBe(REDACTED);
		expect(logged.data.nested.refreshToken).toBe(REDACTED);
		expect(JSON.stringify(logged)).not.toContain("Secret1234!");
		expect(JSON.stringify(logged)).not.toContain("eyJhbGciOi");
	});

	it("masks every name variant the API actually uses", () => {
		const logged = redactLog({
			accessToken: "a",
			refreshToken: "b",
			token: "c",
			otp: "123456",
			verificationCode: "9999",
			apiSecret: "d",
			cardNumber: "4111111111111111",
			cvv: "123",
			accountNumber: "0123456789",
			authorization: "Bearer x",
		}) as Record<string, string>;

		for (const value of Object.values(logged)) {
			expect(value).toBe(REDACTED);
		}
	});

	it("keeps the fields that make a log line useful", () => {
		const logged = redactLog({
			title: "Weekly Q&A",
			kind: "native",
			durationMinutes: 30,
			workspaceId: 2,
			tags: ["alpha", "beta"],
		}) as any;

		expect(logged.title).toBe("Weekly Q&A");
		expect(logged.kind).toBe("native");
		expect(logged.durationMinutes).toBe(30);
		expect(logged.tags).toEqual(["alpha", "beta"]);
	});

	it("masks inside arrays and survives null/undefined", () => {
		const logged = redactLog([
			{ email: "a@b.c", password: "secret" },
			null,
			undefined,
		]) as any[];

		expect(logged[0].email).toBe("a@b.c");
		expect(logged[0].password).toBe(REDACTED);
		expect(logged[1]).toBeNull();
		expect(logged[2]).toBeUndefined();
	});

	it("never mutates the caller's object", () => {
		const body = { email: "a@b.c", password: "Secret1234!" };
		redactLog(body);
		expect(body.password).toBe("Secret1234!");
	});

	it("truncates instead of trusting an absurdly deep payload", () => {
		let deep: any = { password: "Secret1234!" };
		for (let i = 0; i < 12; i++) deep = { nested: deep };
		const logged = JSON.stringify(redactLog(deep));
		expect(logged).not.toContain("Secret1234!");
		expect(logged).toContain("truncated");
	});
});
