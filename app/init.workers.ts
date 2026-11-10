/**
 * Worker process entry point. Every BullMQ consumer is instantiated here, so the API
 * process stays free to answer requests.
 *
 * Run via:
 *   npm run start:dev:workers    (development)
 *   npm run start:prod:workers   (production)
 */

import { connectPostgresDB } from "@/db/postgres.db";
import { CacheService } from "@/services/cache.service";
import { EmailWorkerService } from "@/services/workers/email.worker.service";

// Trigger the Redis + Postgres connections the workers share with the API.
CacheService.getInstance();
connectPostgresDB(async () => {
	console.log("[Workers] Database connected");

	EmailWorkerService.getInstance();

	console.log("[Workers] All workers registered and listening.");
});

// Graceful shutdown
const shutdown = async () => {
	console.log("[Workers] Shutting down...");
	await CacheService.getInstance().close();
	process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
