import "./helpers/app";
import { eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/postgres.db";
import { invitations, workspaces } from "@/db/postgres.schema";
import { buildApp, call, emailJobs, resetQueue } from "./helpers/app";
import { sessionFor } from "./helpers/auth";
import { resetTestDb, setupTestDb } from "./helpers/db";
import {
	addMember,
	createTeam,
	createUser,
	createWorkspace,
} from "./helpers/factories";

type Team = Awaited<ReturnType<typeof createTeam>>;

const DAILY = {
	message:
		"Daily invite limit reached. You can send more invitations tomorrow.",
	code: "INVITE_DAILY_LIMIT",
};
const PLATFORM = {
	message:
		"Invitations are paused for today because of high demand. Please try again tomorrow.",
	code: "INVITE_PLATFORM_LIMIT",
};

describe("invitation daily limits", () => {
	let app: Hono;
	let seq = 0;

	beforeAll(async () => {
		await setupTestDb();
		app = await buildApp();
	});
	beforeEach(async () => {
		await resetTestDb();
		resetQueue();
	});
	afterEach(() => resetQueue());

	const send = async (t: Team, rows: string[]) =>
		call(app, "POST", `/workspaces/${t.workspace.id}/invitations`, {
			headers: await sessionFor(t.admin.id),
			body: {
				invitations: rows.map((email) => ({
					email,
					role: "staff",
					spaceId: String(t.space.id),
				})),
			},
		});

	const fresh = () => `limit${++seq}@example.com`;

	/* @info - Rows go straight into the test DB, with the database clock for age. */
	const seed = async (
		workspaceId: number,
		membershipId: number,
		count: number,
		opts: {
			status?: "pending" | "accepted" | "revoked";
			hoursOld?: number;
		} = {},
	) => {
		const created =
			opts.hoursOld === undefined
				? sql`now()`
				: sql`now() - make_interval(hours => ${opts.hoursOld})`;
		const rows = Array.from({ length: count }, () => {
			seq += 1;
			return {
				workspaceId,
				email: `seed${seq}@example.com`,
				role: "admin" as const,
				spaceId: null,
				tokenHash: String(seq).padStart(64, "0"),
				invitedByMembershipId: membershipId,
				status: opts.status ?? "pending",
				expiresAt: sql`now() + interval '7 days'`,
				createdAt: created,
			};
		});
		for (let i = 0; i < rows.length; i += 100) {
			await getDb()
				.insert(invitations)
				.values(rows.slice(i, i + 100));
		}
	};

	const openWorkspace = async () => {
		const t = await createTeam();
		await getDb()
			.update(workspaces)
			.set({ memberLimit: null })
			.where(eq(workspaces.id, t.workspace.id));
		return t;
	};

	const total = async () => (await getDb().select().from(invitations)).length;

	it("accepts the 70th invitation in a workspace and refuses the 71st with INVITE_DAILY_LIMIT", async () => {
		const t = await openWorkspace();
		await seed(t.workspace.id, t.adminM.id, 69);

		const ok = await send(t, [fresh()]);
		expect(ok.status).toBe(201);
		expect(await total()).toBe(70);
		emailJobs.length = 0;

		const refused = await send(t, [fresh()]);
		expect(refused.status).toBe(429);
		expect(refused.error).toEqual(DAILY);
		expect(await total()).toBe(70);
		expect(emailJobs).toHaveLength(0);
	});

	it("does not limit another workspace", async () => {
		const full = await openWorkspace();
		await seed(full.workspace.id, full.adminM.id, 70);
		const other = await openWorkspace();

		expect((await send(full, [fresh()])).status).toBe(429);
		expect((await send(other, [fresh()])).status).toBe(201);
	});

	it("does not count invitations older than 24 hours", async () => {
		const t = await openWorkspace();
		await seed(t.workspace.id, t.adminM.id, 70, { hoursOld: 25 });

		expect((await send(t, [fresh()])).status).toBe(201);
	});

	it("counts invitations from 23 hours ago", async () => {
		const t = await openWorkspace();
		await seed(t.workspace.id, t.adminM.id, 70, { hoursOld: 23 });

		const res = await send(t, [fresh()]);
		expect(res.status).toBe(429);
		expect(res.error).toEqual(DAILY);
	});

	it("still counts revoked and accepted invitations, so revoking frees nothing", async () => {
		const t = await openWorkspace();
		await seed(t.workspace.id, t.adminM.id, 40, { status: "revoked" });
		await seed(t.workspace.id, t.adminM.id, 30, { status: "accepted" });

		const res = await send(t, [fresh()]);
		expect(res.status).toBe(429);
		expect(res.error).toEqual(DAILY);
	});

	it("revoking through the API does not free a slot", async () => {
		const t = await openWorkspace();
		await seed(t.workspace.id, t.adminM.id, 69);
		const created = await send(t, [fresh()]);
		expect(created.status).toBe(201);
		const revoked = await call(
			app,
			"DELETE",
			`/workspaces/${t.workspace.id}/invitations/${created.data[0].id}`,
			{ headers: await sessionFor(t.admin.id) },
		);
		expect(revoked.status).toBe(200);

		const res = await send(t, [fresh()]);
		expect(res.status).toBe(429);
		expect(res.error).toEqual(DAILY);
	});

	it("refuses a whole batch that would cross the workspace limit and creates nothing", async () => {
		const t = await openWorkspace();
		await seed(t.workspace.id, t.adminM.id, 69);

		const res = await send(t, [fresh(), fresh()]);
		expect(res.status).toBe(429);
		expect(res.error).toEqual(DAILY);
		expect(await total()).toBe(69);
		expect(emailJobs).toHaveLength(0);
	});

	it("lets exactly one of several parallel requests take the last workspace slot", async () => {
		const t = await openWorkspace();
		await seed(t.workspace.id, t.adminM.id, 69);

		const results = await Promise.all(
			[0, 1, 2, 3].map(() => send(t, [fresh()])),
		);
		expect(results.filter((r) => r.status === 201)).toHaveLength(1);
		expect(results.filter((r) => r.status === 429)).toHaveLength(3);
		expect(await total()).toBe(70);
	});

	describe("platform cap", () => {
		/* @info - 299 or 300 rows spread over other workspaces, 60 each, under the per-workspace cap. */
		const fillPlatform = async (count: number) => {
			let left = count;
			while (left > 0) {
				const owner = await createUser();
				const ws = await createWorkspace(owner.id);
				const m = await addMember(ws.id, owner.id, "admin");
				const n = Math.min(60, left);
				await seed(ws.id, m.id, n);
				left -= n;
			}
		};

		it("refuses with INVITE_PLATFORM_LIMIT once 300 were created across workspaces", async () => {
			const t = await openWorkspace();
			await fillPlatform(300);

			const res = await send(t, [fresh()]);
			expect(res.status).toBe(429);
			expect(res.error).toEqual(PLATFORM);
			expect(await total()).toBe(300);
			expect(emailJobs).toHaveLength(0);
		});

		it("accepts the 300th invitation on the platform", async () => {
			const t = await openWorkspace();
			await fillPlatform(299);

			expect((await send(t, [fresh()])).status).toBe(201);
			expect(await total()).toBe(300);
		});

		it("refuses a batch that would cross the platform cap", async () => {
			const t = await openWorkspace();
			await fillPlatform(299);

			const res = await send(t, [fresh(), fresh()]);
			expect(res.status).toBe(429);
			expect(res.error).toEqual(PLATFORM);
			expect(await total()).toBe(299);
		});

		it("does not count platform invitations older than 24 hours", async () => {
			const t = await openWorkspace();
			const owner = await createUser();
			const ws = await createWorkspace(owner.id);
			const m = await addMember(ws.id, owner.id, "admin");
			for (let i = 0; i < 5; i += 1) {
				await seed(ws.id, m.id, 60, { hoursOld: 30 });
			}

			expect((await send(t, [fresh()])).status).toBe(201);
		});

		it("lets exactly one of two workspaces take the last platform slot", async () => {
			const a = await openWorkspace();
			const b = await openWorkspace();
			await fillPlatform(299);

			const results = await Promise.all([
				send(a, [fresh()]),
				send(b, [fresh()]),
			]);
			expect(results.filter((r) => r.status === 201)).toHaveLength(1);
			const refused = results.find((r) => r.status === 429);
			expect(refused?.error).toEqual(PLATFORM);
			expect(await total()).toBe(300);
		});

		it("reports the workspace limit before the platform limit when both are reached", async () => {
			const t = await openWorkspace();
			await seed(t.workspace.id, t.adminM.id, 70);
			await fillPlatform(240);

			const res = await send(t, [fresh()]);
			expect(res.status).toBe(429);
			expect(res.error).toEqual(DAILY);
		});
	});
});
