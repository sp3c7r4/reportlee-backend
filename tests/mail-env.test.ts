import { describe, expect, it } from "vitest";
import { EnvSchema } from "@/config/env";

const base = () => {
	const copy: Record<string, string | undefined> = { ...process.env };
	for (const key of Object.keys(copy)) {
		if (key.startsWith("SMTP_")) delete copy[key];
	}
	delete copy.MAIL_PROVIDER;
	return copy;
};

const smtpVars = {
	SMTP_HOST: "smtp.gmail.com",
	SMTP_PORT: "465",
	SMTP_SECURE: "true",
	SMTP_USER: "a@gmail.com",
	SMTP_PASS: "x",
};

describe("mail env validation", () => {
	it("fails smtp without SMTP_HOST", () => {
		const { SMTP_HOST: _omit, ...rest } = smtpVars;
		const result = EnvSchema.safeParse({
			...base(),
			...rest,
			MAIL_PROVIDER: "smtp",
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues.map((i) => i.path[0])).toContain("SMTP_HOST");
		}
	});

	it("passes smtp with every variable and parses port and secure", () => {
		const result = EnvSchema.safeParse({
			...base(),
			...smtpVars,
			MAIL_PROVIDER: "smtp",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.SMTP_PORT).toBe(465);
			expect(result.data.SMTP_SECURE).toBe(true);
		}
	});

	it("passes resend with no SMTP variables", () => {
		const result = EnvSchema.safeParse({ ...base(), MAIL_PROVIDER: "resend" });
		expect(result.success).toBe(true);
	});

	it("passes resend with empty SMTP variables, as in .env.example", () => {
		const empty = Object.fromEntries(Object.keys(smtpVars).map((k) => [k, ""]));
		const result = EnvSchema.safeParse({
			...base(),
			...empty,
			MAIL_PROVIDER: "resend",
		});
		expect(result.success).toBe(true);
	});

	it("parses SMTP_SECURE=false as false", () => {
		const result = EnvSchema.safeParse({
			...base(),
			...smtpVars,
			SMTP_SECURE: "false",
			MAIL_PROVIDER: "smtp",
		});
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.SMTP_SECURE).toBe(false);
	});
});
