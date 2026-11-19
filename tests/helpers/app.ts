/**
 * Builds the Hono app from the real router, so guards, Zod and the error handler run for real.
 * The email queue is replaced with a recorder (a test can make it throw).
 */
import "./auth";
import { Hono } from "hono";
import { PubSubService } from "@/services/pubsub.service";
import { EmailQueueService } from "@/services/queues/email.queue.service";

export interface RecordedJob {
	name: string;
	data: any;
	opts?: Record<string, unknown>;
}

export const emailJobs: RecordedJob[] = [];
export const queueBehaviour = { fail: false };

/* @info - Same private-slot trick as the cache fake in ./auth. */
(EmailQueueService as unknown as { instance: unknown }).instance = {
	add: async (name: string, data: unknown, opts?: Record<string, unknown>) => {
		if (queueBehaviour.fail) throw new Error("queue unavailable");
		emailJobs.push({ name, data, opts });
	},
};

/* @info - Realtime push is replaced with a recorder: the cache fake has no Redis client. */
export const published: { userId: number; envelope: any }[] = [];
(PubSubService as unknown as { instance: unknown }).instance = {
	publishUser: async (userId: number, envelope: unknown) => {
		published.push({ userId, envelope });
	},
};
export const resetQueue = () => {
	published.length = 0;
	emailJobs.length = 0;
	queueBehaviour.fail = false;
};

export const buildApp = async (): Promise<Hono> => {
	const { router } = await import("@/routes/router");
	const { errorHandler } = await import("@/middlewares/error");
	const app = new Hono({ strict: false });
	app.onError(errorHandler);
	app.route("/api/v1", router);
	return app;
};

/** @info - JSON request helper. */
export const call = async (
	app: Hono,
	method: string,
	path: string,
	options: { headers?: Record<string, string>; body?: unknown } = {},
) => {
	const res = await app.request(`/api/v1${path}`, {
		method,
		headers: {
			...(options.body !== undefined
				? { "Content-Type": "application/json" }
				: {}),
			...options.headers,
		},
		body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
	});
	const text = await res.text();
	let json: any = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = { raw: text };
	}
	return { status: res.status, json, data: json?.data, error: json?.error };
};
