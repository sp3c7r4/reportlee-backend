DO $$ BEGIN CREATE TYPE "public"."membership_role" AS ENUM('staff', 'head', 'admin'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."invitation_status" AS ENUM('pending', 'accepted', 'revoked', 'expired'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."workspace_plan" AS ENUM('starter', 'team', 'enterprise'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspaces" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"name" varchar(120) NOT NULL,
	"slug" varchar(32) NOT NULL,
	"plan" "workspace_plan" DEFAULT 'starter' NOT NULL,
	"member_limit" integer DEFAULT 10,
	"ai_features" boolean DEFAULT false NOT NULL,
	"time_zone" varchar(64) DEFAULT 'UTC' NOT NULL,
	"location_tagging" boolean DEFAULT false NOT NULL,
	"read_only" boolean DEFAULT false NOT NULL,
	"created_by" integer NOT NULL REFERENCES "users"("id"),
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") BETWEEN 3 AND 32)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_slug_lower_uq" ON "workspaces" (lower("slug"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "spaces" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"workspace_id" integer NOT NULL REFERENCES "workspaces"("id"),
	"name" varchar(80) NOT NULL,
	"head_membership_id" integer,
	"kpi_template" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"archived_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "spaces_workspace_name_lower_uq" ON "spaces" ("workspace_id", lower("name"));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "spaces_head_uq" ON "spaces" ("head_membership_id") WHERE "head_membership_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memberships" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"user_id" integer NOT NULL REFERENCES "users"("id"),
	"workspace_id" integer NOT NULL REFERENCES "workspaces"("id"),
	"role" "membership_role" NOT NULL,
	"space_id" integer REFERENCES "spaces"("id"),
	"active" boolean DEFAULT true NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_admin_space_chk" CHECK (("role" = 'admin') = ("space_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memberships_user_workspace_uq" ON "memberships" ("user_id", "workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memberships_workspace_role_idx" ON "memberships" ("workspace_id", "role");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memberships_workspace_space_idx" ON "memberships" ("workspace_id", "space_id");
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "spaces" ADD CONSTRAINT "spaces_head_membership_fk" FOREIGN KEY ("head_membership_id") REFERENCES "memberships"("id") ON DELETE SET NULL; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invitations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"workspace_id" integer NOT NULL REFERENCES "workspaces"("id"),
	"email" varchar(255) NOT NULL,
	"role" "membership_role" NOT NULL,
	"space_id" integer REFERENCES "spaces"("id"),
	"token_hash" char(64) NOT NULL,
	"invited_by_membership_id" integer NOT NULL REFERENCES "memberships"("id"),
	"status" "invitation_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"accepted_at" timestamp,
	"accepted_by_user_id" integer REFERENCES "users"("id"),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_email_lower_chk" CHECK ("email" = lower("email")),
	CONSTRAINT "invitations_admin_space_chk" CHECK (("role" = 'admin') = ("space_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invitations_token_hash_uq" ON "invitations" ("token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invitations_pending_email_uq" ON "invitations" ("workspace_id", "email") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invitations_pending_head_uq" ON "invitations" ("space_id") WHERE "status" = 'pending' AND "role" = 'head';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invitations_workspace_status_idx" ON "invitations" ("workspace_id", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"workspace_id" integer NOT NULL REFERENCES "workspaces"("id"),
	"actor_membership_id" integer REFERENCES "memberships"("id") ON DELETE SET NULL,
	"action" varchar(64) NOT NULL,
	"target" varchar(120) NOT NULL,
	"summary" varchar(500) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_workspace_created_idx" ON "audit_logs" ("workspace_id", "created_at" DESC);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_workspace_id" integer;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "users" ADD CONSTRAINT "users_last_workspace_fk" FOREIGN KEY ("last_workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
