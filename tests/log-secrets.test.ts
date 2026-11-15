import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, format, transports } from "winston";
import { sendSuccessResponse } from "@/helpers/response/send-response";
import { redactMeta } from "@/utils/logger";

const SECRETS = {
	password: "Sentinel-Pass-1!",
	otp: "654321",
	accessToken: "sentinel.access.jwt",
	authorization: "Bearer sentinel.bearer.jwt",
};

describe("secrets never reach logs", () => {
	afterEach(() => vi.restoreAllMocks());

	it("winston redacts sensitive metadata before any transport prints it", () => {
		let out = "";
		const stream = new Writable({
			write(chunk, _enc, cb) {
				out += chunk.toString();
				cb();
			},
		});
		const log = createLogger({
			format: format.combine(redactMeta(), format.json()),
			transports: [new transports.Stream({ stream })],
		});
		log.info("job", { data: SECRETS, recipient: "a@example.com" });
		for (const value of Object.values(SECRETS)) {
			expect(out).not.toContain(value);
		}
		expect(out).toContain("a@example.com");
	});

	it("sendSuccessResponse logs a redacted body but still returns the real one", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const c = { json: vi.fn((body: unknown) => body) } as any;
		sendSuccessResponse(c, { ...SECRETS, name: "Ada" });
		const printed = JSON.stringify(spy.mock.calls);
		for (const value of Object.values(SECRETS)) {
			expect(printed).not.toContain(value);
		}
		expect(c.json.mock.calls[0][0].data.accessToken).toBe(SECRETS.accessToken);
	});
});
