import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { HonoAdapter } from "@bull-board/hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { WebSocketServer } from "ws";
import { config } from "@/config";
import { connectPostgresDB, connectRedisDB } from "@/db";
import { healthCheck } from "@/helpers";
import { errorHandler, RequestLogger, routeNotFound } from "@/middlewares";
import { router } from "@/routes";
import { EmailQueueService } from "@/services";
import { waitForSocket } from "@/services/websocket.handler";
import { logger } from "@/utils";

const app = new Hono({
	strict: false,
});

let PORT: number = config.server.port;

/** @info - WebSocket endpoint. Registered BEFORE CORS/RequestLogger — header
 *          middleware breaks the upgrade. */
app.get("/ws", waitForSocket);

/** @info - CORS. The allowlist comes from ORIGINS, so a browser can only call the
 * API from the app itself; "*" here would let any page use a reader's session. */
app.use(
	"*",
	cors({
		origin: (origin) =>
			!origin || config.server.origins.includes(origin) ? origin : "",
		allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization", "Accept"],
		credentials: true,
	}),
);

const getMessage = (port: number) => `
================================================
Server Application Started!
API V1: http://${config.server.hostname}:${port}
QUEUE Dashboard: http://${config.server.hostname}:${port}/queue
================================================
`;

app.use("*", RequestLogger);

app.get("/", healthCheck);

app.route("/api/v1", router);

/** @info - BullMQ dashboard: every queue this app owns, one adapter each. */
const bullMQAdapter = new HonoAdapter(serveStatic);
bullMQAdapter.setBasePath("/queue");

createBullBoard({
	queues: [new BullMQAdapter(EmailQueueService.getInstance().getQueue())],
	serverAdapter: bullMQAdapter,
});

app.route("/queue", bullMQAdapter.registerPlugin());

let server: ReturnType<typeof serve>;

function startServer(port: number = PORT) {
	const wss = new WebSocketServer({ noServer: true });
	server = serve({
		fetch: app.fetch,
		hostname: config.server.hostname,
		port: port,
		websocket: { server: wss },
	});

	console.log(getMessage(port));
	server.on("error", (err) => {
		if (err instanceof Error && (err as any).code === "EADDRINUSE") {
			const newPort = port + 1;
			logger.error(
				`Port ${port} is already in use. Retrying with port ${newPort}`,
			);
			PORT = newPort;
			setTimeout(() => {
				server.close();
				startServer(newPort);
			}, 1000);
		} else {
			logger.error(
				`Failed to start server: ${err instanceof Error ? err.message : "Unknown error"}`,
			);
			throw err;
		}
	});
}

// Initialize PostgreSQL and Redis
connectPostgresDB(startServer);
connectRedisDB();

app.use("*", routeNotFound);

app.onError((err: Error & { code?: string }, c) => {
	return errorHandler(err, c);
});

/** @info - Server closures */
process.on("SIGINT", () => {
	server.close();
	process.exit(0);
});

process.on("SIGTERM", () => {
	server.close();
	process.exit(0);
});
