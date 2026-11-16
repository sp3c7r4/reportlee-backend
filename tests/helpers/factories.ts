/** Fake data only (@example.com). Inserts go straight to the real test database. */
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/postgres.db";
import {
	memberships,
	spaces,
	user_roles,
	users,
	workspaces,
} from "@/db/postgres.schema";

let counter = 0;
const next = () => {
	counter += 1;
	return counter;
};

export const createUser = async (
	overrides: Partial<typeof users.$inferInsert> & {
		platformAdmin?: boolean;
	} = {},
) => {
	const { platformAdmin, ...rest } = overrides;
	const n = next();
	const [row] = await getDb()
		.insert(users)
		.values({
			firstName: `Test${n}`,
			lastName: "Person",
			email: `person${n}-${Date.now()}@example.com`,
			emailVerified: true,
			...rest,
		})
		.returning();
	if (!row) throw new Error("user insert failed");
	if (platformAdmin) {
		await getDb().insert(user_roles).values({ userId: row.id, role: "admin" });
	}
	return row;
};

export const createWorkspace = async (
	createdBy: number,
	overrides: Partial<typeof workspaces.$inferInsert> = {},
) => {
	const n = next();
	const [row] = await getDb()
		.insert(workspaces)
		.values({
			name: `Workspace ${n}`,
			slug: `ws-${n}-${Math.random().toString(36).slice(2, 7)}`,
			createdBy,
			...overrides,
		})
		.returning();
	if (!row) throw new Error("workspace insert failed");
	return row;
};

export const createSpace = async (
	workspaceId: number,
	name = `Space ${next()}`,
	overrides: Partial<typeof spaces.$inferInsert> = {},
) => {
	const [row] = await getDb()
		.insert(spaces)
		.values({ workspaceId, name, ...overrides })
		.returning();
	if (!row) throw new Error("space insert failed");
	return row;
};

export const addMember = async (
	workspaceId: number,
	userId: number,
	role: "staff" | "head" | "admin",
	spaceId: number | null = null,
	active = true,
) => {
	const [row] = await getDb()
		.insert(memberships)
		.values({ workspaceId, userId, role, spaceId, active })
		.returning();
	if (!row) throw new Error("membership insert failed");
	if (role === "head" && spaceId) {
		await getDb()
			.update(spaces)
			.set({ headMembershipId: row.id })
			.where(and(eq(spaces.id, spaceId), eq(spaces.workspaceId, workspaceId)));
	}
	return row;
};

/** @info - A workspace with one Admin, one Space, a Head and a Staff member in it. */
export const createTeam = async () => {
	const admin = await createUser();
	const workspace = await createWorkspace(admin.id);
	const adminM = await addMember(workspace.id, admin.id, "admin");
	const space = await createSpace(workspace.id, "Platform");
	const headUser = await createUser();
	const headM = await addMember(workspace.id, headUser.id, "head", space.id);
	const staffUser = await createUser();
	const staffM = await addMember(workspace.id, staffUser.id, "staff", space.id);
	return {
		workspace,
		space,
		admin,
		adminM,
		headUser,
		headM,
		staffUser,
		staffM,
	};
};
