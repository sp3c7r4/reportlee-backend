import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { EnvSchema } from "@/config/env";
import { queueDashboardGuard } from "@/middlewares/queue-dashboard";

const PASSWORD = "test-dashboard-pass-1";

const appWith = (guard: ReturnType<typeof queueDashboardGuard>) => {
	const app = new Hono();
	if (guard) app.use("/queue/*", guard);
	app.get("/queue/x", (c) => c.text("board"));
	return app;
};

const basic = (user: string, pass: string) =>
	`Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

describe("queue dashboard guard", () => {
	it("is not mounted in production without a password", () => {
		expect(
			queueDashboardGuard({ nodeEnv: "production", user: "admin" }),
		).toBeNull();
		expect(
			queueDashboardGuard({ nodeEnv: "staging", user: "admin" }),
		).toBeNull();
	});

	it("rejects missing and wrong credentials, accepts the right ones", async () => {
		const app = appWith(
			queueDashboardGuard({
				nodeEnv: "production",
				user: "admin",
				password: PASSWORD,
			}),
		);
		expect((await app.request("/queue/x")).status).toBe(401);
		const wrong = await app.request("/queue/x", {
			headers: { Authorization: basic("admin", "nope") },
		});
		expect(wrong.status).toBe(401);
		const ok = await app.request("/queue/x", {
			headers: { Authorization: basic("admin", PASSWORD) },
		});
		expect(ok.status).toBe(200);
	});

	it("stays open in development without a password", async () => {
		const app = appWith(
			queueDashboardGuard({ nodeEnv: "development", user: "admin" }),
		);
		expect((await app.request("/queue/x")).status).toBe(200);
	});

	it("rejects a short dashboard password in the env schema", () => {
		const shape = EnvSchema.shape.QUEUE_DASHBOARD_PASSWORD;
		expect(shape.safeParse("short").success).toBe(false);
		expect(shape.safeParse("").success).toBe(true);
		expect(shape.safeParse(PASSWORD).success).toBe(true);
	});
});
