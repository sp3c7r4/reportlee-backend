import { sql } from "drizzle-orm";
import {
	char,
	check,
	index,
	integer,
	pgEnum,
	pgTable,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
import { TableNames } from "@/enums";
import { timestamps } from "@/models/timestamps.b.model";
import {
	membershipRole,
	memberships,
} from "@/modules/membership/membership.model";
import { spaces } from "@/modules/space/space.model";
import { users } from "@/modules/user/user.model";
import { workspaces } from "@/modules/workspace/workspace.model";

export const invitationStatus = pgEnum("invitation_status", [
	"pending",
	"accepted",
	"revoked",
	"expired",
]);

export const invitations = pgTable(
	TableNames.INVITATIONS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		workspaceId: integer("workspace_id")
			.notNull()
			.references(() => workspaces.id),
		/** @info - Lower-cased on write (a CHECK enforces it). */
		email: varchar("email", { length: 255 }).notNull(),
		role: membershipRole("role").notNull(),
		spaceId: integer("space_id").references(() => spaces.id),
		/** @info - sha256 hex of the token. The token itself is never stored. */
		tokenHash: char("token_hash", { length: 64 }).notNull(),
		invitedByMembershipId: integer("invited_by_membership_id")
			.notNull()
			.references(() => memberships.id),
		status: invitationStatus("status").default("pending").notNull(),
		expiresAt: timestamp("expires_at").notNull(),
		acceptedAt: timestamp("accepted_at"),
		acceptedByUserId: integer("accepted_by_user_id").references(() => users.id),
		...timestamps,
	},
	(table) => [
		uniqueIndex("invitations_token_hash_uq").on(table.tokenHash),
		uniqueIndex("invitations_pending_email_uq")
			.on(table.workspaceId, table.email)
			.where(sql`${table.status} = 'pending'`),
		uniqueIndex("invitations_pending_head_uq")
			.on(table.spaceId)
			.where(sql`${table.status} = 'pending' AND ${table.role} = 'head'`),
		index("invitations_workspace_status_idx").on(
			table.workspaceId,
			table.status,
		),
		check(
			"invitations_email_lower_chk",
			sql`${table.email} = lower(${table.email})`,
		),
		check(
			"invitations_admin_space_chk",
			sql`(${table.role} = 'admin') = (${table.spaceId} IS NULL)`,
		),
	],
);

export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;
