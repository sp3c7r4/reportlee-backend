import { beforeEach, describe, expect, it, vi } from "vitest";

const { SENTINEL } = vi.hoisted(() => ({ SENTINEL: "test-sentinel-pass" }));

const mocks = vi.hoisted(() => ({
	createTransport: vi.fn(),
	sendMail: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
}));

vi.mock("nodemailer", () => ({
	default: { createTransport: mocks.createTransport },
}));

vi.mock("@/utils", () => ({
	logger: { info: mocks.info, error: mocks.error },
}));

vi.mock("@/config", () => ({
	config: {
		mail: {
			provider: "smtp",
			domain: "example.com",
			fromName: "Reportlee",
			logoUrl: "",
		},
		smtp: {
			host: "smtp.gmail.com",
			port: 465,
			secure: true,
			user: "sender@gmail.com",
			pass: SENTINEL,
		},
		aws: {
			region: "eu-west-1",
			accessKeyId: "id",
			secretAccessKey: "secret",
			resend: { apiKey: "re_key", domain: "resend.example.com" },
		},
	},
}));

import {
	buildTransport,
	EmailService,
	mailSender,
} from "@/services/mail.service";

const send = () =>
	EmailService.getInstance().send({
		template: "verify-otp",
		identifier: "notification",
		message: { to: "user@example.com", subject: "Your code" },
		locals: {
			name: "Ada",
			otp: "123456",
			expiryMinutes: 10,
			ipAddress: "1.1.1.1",
			location: "Lagos",
			device: "Chrome",
			timestamp: "now",
		},
	} as any);

const logged = () =>
	JSON.stringify([...mocks.info.mock.calls, ...mocks.error.mock.calls]);

describe("smtp mail provider", () => {
	beforeEach(() => {
		mocks.createTransport.mockReset();
		mocks.createTransport.mockReturnValue({ sendMail: mocks.sendMail });
		mocks.sendMail.mockReset();
		mocks.sendMail.mockResolvedValue({});
		mocks.info.mockClear();
		mocks.error.mockClear();
	});

	it("builds the transport from the smtp config", () => {
		buildTransport("smtp");
		expect(mocks.createTransport).toHaveBeenCalledWith({
			host: "smtp.gmail.com",
			port: 465,
			secure: true,
			auth: { user: "sender@gmail.com", pass: SENTINEL },
		});
	});

	it("sends from SMTP_USER with the display name", () => {
		expect(mailSender("smtp")).toEqual({
			name: "Reportlee",
			address: "sender@gmail.com",
		});
	});

	it("ignores the identifier, never logs the password or OTP, and sends once", async () => {
		await send();
		expect(mocks.sendMail).toHaveBeenCalledTimes(1);
		expect(mocks.sendMail.mock.calls[0]![0]!.from).toEqual({
			name: "Reportlee",
			address: "sender@gmail.com",
		});
		expect(logged()).not.toContain(SENTINEL);
		expect(logged()).not.toContain("123456");
	});

	it("logs a rejected send without body or OTP, then rethrows so BullMQ retries", async () => {
		mocks.sendMail.mockRejectedValueOnce(new Error("auth failed"));
		await expect(send()).rejects.toThrow("auth failed");
		expect(mocks.error).toHaveBeenCalledTimes(1);
		expect(logged()).toContain("auth failed");
		expect(logged()).not.toContain(SENTINEL);
		expect(logged()).not.toContain("123456");
		expect(logged()).not.toContain("user@example.com");
	});

	it("keeps resend and ses off the Gmail options", () => {
		buildTransport("resend");
		expect(mocks.createTransport.mock.calls[0]![0]!.host).toBe(
			"smtp.resend.com",
		);
		buildTransport("ses");
		expect(mocks.createTransport.mock.calls[1]![0]!.host).toBeUndefined();
		expect(mocks.createTransport.mock.calls[1]![0]!.SES).toBeDefined();
	});
});
