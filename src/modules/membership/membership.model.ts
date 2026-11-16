import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	index,
	integer,
	pgEnum,
	pgTable,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { TableNames } from "@/enums";
import { timestamps } from "@/models/timestamps.b.model";
import { spaces } from "@/modules/space/space.model";
import { users } from "@/modules/user/user.model";
import { workspaces } from "@/modules/workspace/workspace.model";

/** @info - Workspace roles. Not the platform role in user_roles (D1). */
export const membershipRole = pgEnum("membership_role", [
	"staff",
	"head",
	"admin",
]);

export type MembershipRole = (typeof membershipRole.enumValues)[number];

export const memberships = pgTable(
	TableNames.MEMBERSHIPS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id),
		workspaceId: integer("workspace_id")
			.notNull()
			.references(() => workspaces.id),
		role: membershipRole("role").notNull(),
		spaceId: integer("space_id").references(() => spaces.id),
		active: boolean("active").default(true).notNull(),
		joinedAt: timestamp("joined_at").defaultNow().notNull(),
		...timestamps,
	},
	(table) => [
		uniqueIndex("memberships_user_workspace_uq").on(
			table.userId,
			table.workspaceId,
		),
		index("memberships_workspace_role_idx").on(table.workspaceId, table.role),
		index("memberships_workspace_space_idx").on(
			table.workspaceId,
			table.spaceId,
		),
		check(
			"memberships_admin_space_chk",
			sql`(${table.role} = 'admin') = (${table.spaceId} IS NULL)`,
		),
	],
);

export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
