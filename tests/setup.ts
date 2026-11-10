/**
 * Test setup — runs once before every test file.
 *
 * Deliberately small: the unit tests here read no database and open no socket, so a
 * fresh clone can run `npm test` with nothing but `.env.test` (which ships with dummy
 * values). An integration suite that needs Postgres is opt-in: give it its own file
 * and connect inside a beforeAll.
 */

import { Hono } from "hono";
import { errorHandler, routeNotFound } from "@/middlewares";

console.log("[Test] Setup loaded.");

/** Build a clean Hono app with the real error and 404 handling, no live services. */
export function createTestApp(): Hono {
	const app = new Hono({ strict: false });
	app.use("*", routeNotFound);
	app.onError(errorHandler);
	return app;
}

/** Singleton test app — reuse across test files */
export const testApp = createTestApp();
