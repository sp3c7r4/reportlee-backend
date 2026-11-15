import type { MiddlewareHandler } from "hono";
import { basicAuth } from "hono/basic-auth";

interface QueueDashboardOptions {
	nodeEnv: string;
	user: string;
	password?: string;
}

/**
 * @info - Guard for the BullMQ dashboard, which can retry or delete jobs and shows
 * job data (recipient emails). With a password it is behind basic auth in every
 * environment. Without one it exists only in development; anywhere else it returns
 * null and the caller must not mount the route.
 */
export const queueDashboardGuard = ({
	nodeEnv,
	user,
	password,
}: QueueDashboardOptions): MiddlewareHandler | null => {
	if (password) return basicAuth({ username: user, password });
	if (nodeEnv === "development") {
		return async (_c, next) => {
			await next();
		};
	}
	return null;
};
