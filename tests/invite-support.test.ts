import { describe, expect, it, vi } from "vitest";
import { REDACTED, redactLog } from "@/helpers/log-redact.helper";

/** @info - Small guards for the shared-file changes the invitations slice made (D29, task 1.7). */
describe("redactLog inviteUrl", () => {
	it("masks an invitation link at any depth, whatever the key case", () => {
		const logged = redactLog({
			data: [
				{ inviteUrl: "https://app.example.com/invite/secret-token-value" },
			],
			other: { InviteURL: "https://app.example.com/invite/another-token" },
		});
		const text = JSON.stringify(logged);
		expect(text).not.toContain("secret-token-value");
		expect(text).not.toContain("another-token");
		expect(text).toContain(REDACTED);
	});
});

describe("BaseQueueService.add per-call options", () => {
	const load = async () => {
		const add = vi.fn(async () => undefined);
		vi.resetModules();
		vi.doMock("bullmq", () => ({
			Queue: class {
				add = add;
			},
			QueueEvents: class {
				on() {}
			},
		}));
		vi.doMock("@/services/cache.service", () => ({
			CacheService: {
				getInstance: () => ({ getConnectionOptions: () => ({}) }),
			},
		}));
		const { BaseQueueService } = await import(
			"@/bases/services/base.queue.service"
		);
		const queue = new BaseQueueService<{ idempotencyKey?: string }>({
			queueName: "q",
			alias: "Q",
			args: { attempts: 5 },
		});
		return { add, queue };
	};

	it("keeps the defaults when no options are passed", async () => {
		const { add, queue } = await load();
		await queue.add("job", { idempotencyKey: "k1" });
		const opts = (add.mock.calls[0] as unknown[])[2] as Record<string, any>;
		expect(opts.attempts).toBe(5);
		expect(opts.removeOnComplete).toMatchObject({ count: 1000 });
		expect(opts.deduplication).toEqual({ id: "k1" });
	});

	it("lets one caller override retention, last", async () => {
		const { add, queue } = await load();
		await queue.add(
			"job",
			{ idempotencyKey: "k2" },
			{ removeOnComplete: true, removeOnFail: { age: 86400 } },
		);
		const opts = (add.mock.calls[0] as unknown[])[2] as Record<string, any>;
		expect(opts.removeOnComplete).toBe(true);
		expect(opts.removeOnFail).toEqual({ age: 86400 });
		expect(opts.attempts).toBe(5);
		expect(opts.deduplication).toEqual({ id: "k2" });
	});
});
