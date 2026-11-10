import { relations, sql } from "drizzle-orm";
import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
import { TableNames } from "@/enums";
import type { IUserPreferences } from "@/interfaces";
import { softDelete } from "@/models/soft-delete.model";
import { timestamps } from "@/models/timestamps.b.model";
import { user_roles } from "./user-role.model";

export const users = pgTable(
	TableNames.USERS,
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		firstName: varchar("first_name", { length: 255 }).notNull(),
		lastName: varchar("last_name", { length: 255 }).notNull(),
		email: varchar("email", { length: 255 }).notNull(),
		passwordHash: varchar("password_hash", { length: 255 }),
		avatarUrl: varchar("avatar_url", { length: 500 }),
		bio: text("bio"),
		/** @info - A short professional headline shown under the name. Distinct
		 *         from user_roles.role, which is the authorisation role. */
		title: varchar("title", { length: 120 }),
		phone: varchar("phone", { length: 50 }),
		phoneVerified: boolean("phone_verified").default(false),
		emailVerified: boolean("email_verified").default(false),
		emailVerifiedAt: timestamp("email_verified_at"),
		lastLoginAt: timestamp("last_login_at"),
		passwordChangedAt: timestamp("password_changed_at"),
		onboarded: boolean("onboarded").default(false),
		preferences: jsonb("preferences")
			.$type<IUserPreferences>()
			.default({
				theme: "system",
				locale: "en-US",
				timezone: "UTC",
				notifications: {
					email: true,
					sms: false,
					whatsapp: false,
					push: true,
				},
			}),
		suspendedAt: timestamp("suspended_at"),
		...softDelete,
		...timestamps,
	},
	(table) => [
		/* @info - Email uniqueness is CASE-INSENSITIVE: Test@mail.com and
		 * test@mail.com are one account. Code paths store and look up lowercase. */
		uniqueIndex("uq_users_email_lower").on(sql`lower(${table.email})`),
		index("idx_users_deleted_at").on(table.deletedAt),
	],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export const usersRelations = relations(users, ({ many }) => ({
	roles: many(user_roles),
}));
