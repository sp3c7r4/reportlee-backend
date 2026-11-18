DO $$ BEGIN CREATE TYPE "public"."schedule_cadence" AS ENUM('daily', 'weekly', 'fortnightly', 'monthly', 'quarterly'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."report_submission_status" AS ENUM('draft', 'submitted', 'late'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."report_review_status" AS ENUM('pending', 'approved', 'rejected'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."report_event_kind" AS ENUM('submitted', 'edited', 'seen', 'approved', 'rejected', 'reopened'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "edit_window_minutes" integer NOT NULL DEFAULT 30;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_edit_window_chk" CHECK ("edit_window_minutes" BETWEEN 1 AND 10080); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_schedules" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"workspace_id" integer NOT NULL,
	"cadence" "schedule_cadence" NOT NULL,
	"weekday" varchar(9),
	"time_of_day" char(5) NOT NULL,
	"time_zone" varchar(64) NOT NULL,
	"day_of_month" smallint,
	"last_day" boolean DEFAULT false NOT NULL,
	"anchor_date" date,
	"effective_from" timestamptz NOT NULL,
	"created_by_membership_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "workspace_schedules" ADD CONSTRAINT "workspace_schedules_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "workspace_schedules" ADD CONSTRAINT "workspace_schedules_creator_fk" FOREIGN KEY ("created_by_membership_id") REFERENCES "memberships"("id") ON DELETE SET NULL; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "workspace_schedules" ADD CONSTRAINT "workspace_schedules_time_chk" CHECK ("time_of_day" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "workspace_schedules" ADD CONSTRAINT "workspace_schedules_dom_chk" CHECK ("day_of_month" IS NULL OR "day_of_month" BETWEEN 1 AND 31); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "workspace_schedules" ADD CONSTRAINT "workspace_schedules_weekday_chk" CHECK ("cadence" NOT IN ('weekly', 'fortnightly') OR "weekday" IS NOT NULL); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "workspace_schedules" ADD CONSTRAINT "workspace_schedules_anchor_chk" CHECK ("cadence" <> 'fortnightly' OR "anchor_date" IS NOT NULL); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "workspace_schedules" ADD CONSTRAINT "workspace_schedules_day_chk" CHECK ("cadence" NOT IN ('monthly', 'quarterly') OR "day_of_month" IS NOT NULL OR "last_day"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_schedules_ws_effective_uq" ON "workspace_schedules" ("workspace_id", "effective_from");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reporting_periods" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"workspace_id" integer NOT NULL,
	"label" varchar(80) NOT NULL,
	"starts_at" timestamptz NOT NULL,
	"ends_at" timestamptz NOT NULL,
	"due_at" timestamptz NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "reporting_periods" ADD CONSTRAINT "reporting_periods_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "reporting_periods" ADD CONSTRAINT "reporting_periods_order_chk" CHECK ("starts_at" < "ends_at" AND "ends_at" < "due_at"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reporting_periods_ws_start_uq" ON "reporting_periods" ("workspace_id", "starts_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reporting_periods_ws_due_idx" ON "reporting_periods" ("workspace_id", "due_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reports" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"workspace_id" integer NOT NULL,
	"period_id" integer NOT NULL,
	"author_membership_id" integer NOT NULL,
	"space_id" integer NOT NULL,
	"accomplishments" text DEFAULT '' NOT NULL,
	"challenges" text DEFAULT '' NOT NULL,
	"plans" text DEFAULT '' NOT NULL,
	"kpis" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tagged_membership_ids" integer[] DEFAULT '{}' NOT NULL,
	"location" jsonb,
	"submission_status" "report_submission_status" DEFAULT 'draft' NOT NULL,
	"review_status" "report_review_status" DEFAULT 'pending' NOT NULL,
	"submitted_at" timestamptz,
	"first_seen_at" timestamptz,
	"window_started_at" timestamptz,
	"edit_window_minutes" integer DEFAULT 30 NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "reports" ADD CONSTRAINT "reports_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "reports" ADD CONSTRAINT "reports_period_fk" FOREIGN KEY ("period_id") REFERENCES "reporting_periods"("id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "reports" ADD CONSTRAINT "reports_author_fk" FOREIGN KEY ("author_membership_id") REFERENCES "memberships"("id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "reports" ADD CONSTRAINT "reports_space_fk" FOREIGN KEY ("space_id") REFERENCES "spaces"("id"); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "reports" ADD CONSTRAINT "reports_submitted_chk" CHECK (("submission_status" = 'draft') = ("submitted_at" IS NULL)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "reports" ADD CONSTRAINT "reports_edit_window_chk" CHECK ("edit_window_minutes" BETWEEN 1 AND 10080); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reports_period_author_live_uq" ON "reports" ("period_id", "author_membership_id") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reports_ws_period_space_idx" ON "reports" ("workspace_id", "period_id", "space_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reports_author_period_idx" ON "reports" ("author_membership_id", "period_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "report_revisions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"report_id" integer NOT NULL,
	"previous" jsonb NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "report_revisions" ADD CONSTRAINT "report_revisions_report_fk" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_revisions_report_idx" ON "report_revisions" ("report_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "report_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"report_id" integer NOT NULL,
	"kind" "report_event_kind" NOT NULL,
	"actor_membership_id" integer NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "report_events" ADD CONSTRAINT "report_events_report_fk" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "report_events" ADD CONSTRAINT "report_events_actor_fk" FOREIGN KEY ("actor_membership_id") REFERENCES "memberships"("id") ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_events_report_created_idx" ON "report_events" ("report_id", "created_at");
