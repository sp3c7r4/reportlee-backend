import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	send: vi.fn(),
}));

vi.mock("@/utils", () => ({
	logger: { info: mocks.info, warn: mocks.warn, error: mocks.error },
}));

vi.mock("@/services/cache.service", () => ({
	CacheService: {
		getInstance: () => ({
			getConnectionOptions: () => ({}),
			redis: { set: async () => "OK", del: async () => 1 },
		}),
	},
}));

vi.mock("bullmq", () => ({
	Worker: class {
		on() {}
		close() {}
	},
}));

vi.mock("@/services/mail.service", () => ({
	EmailService: { getInstance: () => ({ send: mocks.send }) },
}));

import { redactEmails } from "@/helpers/log-redact.helper";
import { EmailWorkerService } from "@/services/workers/email.worker.service";

const logged = () =>
	JSON.stringify([
		...mocks.info.mock.calls,
		...mocks.warn.mock.calls,
		...mocks.error.mock.calls,
	]);

const job = {
	id: "job-1",
	name: "invitation",
	attemptsMade: 0,
	data: {
		message: { to: "invitee@example.com", subject: "Hello" },
		template: "invitation",
		locals: { inviteUrl: "https://app.example.com/invite/abc", otp: "654321" },
		idempotencyKey: "invitation:1",
	},
};

describe("email worker logs", () => {
	it("redactEmails masks every address and keeps the rest", () => {
		expect(
			redactEmails("550 <a.b@example.com> rejected, cc c@example.org too"),
		).toBe("550 <<email>> rejected, cc <email> too");
	});

	it("logs the job id and template on success, never the address", async () => {
		mocks.send.mockResolvedValueOnce(undefined);
		const worker = EmailWorkerService.getInstance() as any;
		await worker.idempotentProcess(job);
		expect(logged()).toContain("job-1");
		expect(logged()).toContain("invitation");
		expect(logged()).not.toContain("invitee@example.com");
	});

	it("scrubs an address quoted in a failure, and logs no job data", async () => {
		mocks.error.mockClear();
		mocks.send
			.mockRejectedValueOnce(new Error("550 No such user invitee@example.com"))
			.mockRejectedValueOnce(new Error("550 No such user invitee@example.com"));
		const worker = EmailWorkerService.getInstance() as any;
		await expect(worker.idempotentProcess(job)).rejects.toThrow();
		await expect(worker.handle(job)).rejects.toThrow();
		expect(mocks.error).toHaveBeenCalled();
		expect(logged()).not.toContain("invitee@example.com");
		expect(logged()).not.toContain("654321");
		expect(logged()).not.toContain("/invite/abc");
	});
});
