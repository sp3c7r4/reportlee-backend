DO $$ BEGIN CREATE TYPE "public"."comment_kind" AS ENUM('comment', 'decision'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."task_status" AS ENUM('todo', 'doing', 'done'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."task_priority" AS ENUM('low', 'medium', 'high', 'critical'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "report_comments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"report_id" integer NOT NULL,
	"author_membership_id" integer NOT NULL,
	"kind" "comment_kind" DEFAULT 'comment' NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "report_comments" ADD CONSTRAINT "report_comments_report_fk" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "report_comments" ADD CONSTRAINT "report_comments_author_fk" FOREIGN KEY ("author_membership_id") REFERENCES "memberships"("id") ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "report_comments" ADD CONSTRAINT "report_comments_body_chk" CHECK (char_length("body") BETWEEN 1 AND 2000); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_comments_report_created_idx" ON "report_comments" ("report_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tasks" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"workspace_id" integer NOT NULL,
	"report_id" integer NOT NULL,
	"comment_id" integer,
	"title" varchar(200) NOT NULL,
	"assignee_membership_id" integer NOT NULL,
	"assigned_by_membership_id" integer NOT NULL,
	"due_on" date NOT NULL,
	"status" "task_status" DEFAULT 'todo' NOT NULL,
	"priority" "task_priority" NOT NULL,
	"completion_note" text,
	"completion_file" jsonb,
	"completed_at" timestamptz,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "tasks" ADD CONSTRAINT "tasks_report_fk" FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "tasks" ADD CONSTRAINT "tasks_comment_fk" FOREIGN KEY ("comment_id") REFERENCES "report_comments"("id") ON DELETE SET NULL; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_fk" FOREIGN KEY ("assignee_membership_id") REFERENCES "memberships"("id") ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigner_fk" FOREIGN KEY ("assigned_by_membership_id") REFERENCES "memberships"("id") ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "tasks" ADD CONSTRAINT "tasks_title_chk" CHECK (char_length("title") BETWEEN 1 AND 200); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "tasks" ADD CONSTRAINT "tasks_note_chk" CHECK ("completion_note" IS NULL OR char_length("completion_note") <= 1000); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "tasks" ADD CONSTRAINT "tasks_done_chk" CHECK (("status" = 'done') = ("completed_at" IS NOT NULL)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_assignee_status_idx" ON "tasks" ("assignee_membership_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_ws_assigner_idx" ON "tasks" ("workspace_id", "assigned_by_membership_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_report_idx" ON "tasks" ("report_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_comment_uq" ON "tasks" ("comment_id") WHERE "comment_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "workspace_id" integer;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "membership_id" integer;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "href" varchar(255);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "notifications" ADD CONSTRAINT "notifications_membership_fk" FOREIGN KEY ("membership_id") REFERENCES "memberships"("id") ON DELETE SET NULL; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_ws_read_idx" ON "notifications" ("user_id", "workspace_id", "read_at");
--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'decision';
--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'comment';
--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'task';
--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'submission';
