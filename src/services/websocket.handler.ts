import { upgradeWebSocket } from "@hono/node-server";
import type { Context } from "hono";
import type { IAuthData, IJwtPayload } from "@/interfaces/auth/auth.interface";
import { CacheService } from "@/services/cache.service";
import { JwtService } from "@/services/jwt.service";
import { PubSubService } from "@/services/pubsub.service";
import { WebsocketEngine } from "@/services/websocket.service";

/**
 * @info - The socket endpoint: `GET /ws?token=<access token>`.
 *
 * A browser cannot set an Authorization header on an upgrade, so the token travels
 * in the query string and is checked before the socket is registered. Anything the
 * client does not understand is answered with an error envelope rather than a close,
 * so a bad message cannot silently end a session.
 *
 * The envelope is the REST one: { timestamp, status, success, data | error }.
 * Registered BEFORE the CORS/RequestLogger middleware in app/server.ts — header
 * middleware breaks the upgrade.
 */

const AUTH_FAIL_CODE = 4401;

const out = (type: string, payload: unknown) => ({
	timestamp: new Date().toISOString(),
	status: 200,
	success: true,
	data: { type, payload },
});

const outErr = (message: string, code = "BAD_EVENT") => ({
	timestamp: new Date().toISOString(),
	status: 400,
	success: false,
	error: { code, message },
});

export const waitForSocket = upgradeWebSocket((c: Context) => {
	let userId: number | null = null;
	let liveWs: { close(code?: number, reason?: string): void } | null = null;

	return {
		onOpen: async (_event, ws) => {
			liveWs = ws;
			try {
				const token = c.req.query("token") ?? "";
				const decoded =
					JwtService.getInstance().verifyToken<IJwtPayload>(token);
				const data = await CacheService.getInstance().get<IAuthData>(
					decoded.authId,
				);
				if (!data?.id) throw new Error("Session not found");
				userId = data.id;
			} catch {
				ws.close(AUTH_FAIL_CODE, "Unauthorized");
				return;
			}

			WebsocketEngine.getInstance().add(userId!, ws);
			await PubSubService.getInstance().subscribeUser(userId!);
		},

		onMessage: async (event, ws) => {
			if (userId === null) {
				ws.close(AUTH_FAIL_CODE, "Unauthorized");
				return;
			}

			let parsed: { type?: string } | null = null;
			try {
				parsed = JSON.parse(String(event.data));
			} catch {
				ws.send(JSON.stringify(outErr("Invalid JSON", "INVALID_JSON")));
				return;
			}

			if (parsed?.type === "ping") {
				ws.send(JSON.stringify(out("pong", {})));
				return;
			}

			/* @info - Add the events the product needs here (read receipts, typing,
			 * presence). Everything else is answered, never dropped in silence. */
			ws.send(
				JSON.stringify(
					outErr(`Unknown event type: ${parsed?.type ?? "?"}`, "UNKNOWN_EVENT"),
				),
			);
		},

		onClose: async () => {
			if (userId === null) return;
			WebsocketEngine.getInstance().remove(
				userId,
				liveWs as unknown as Parameters<
					typeof WebsocketEngine.prototype.remove
				>[1],
			);
			await PubSubService.getInstance().unsubscribeUser(userId);
		},

		onError: (err) => {
			if (userId !== null)
				console.warn(
					`[ws] error for user ${userId}:`,
					(err as unknown as Error)?.message,
				);
		},
	};
});
