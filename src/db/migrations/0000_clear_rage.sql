CREATE TYPE "public"."user_role" AS ENUM('admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('system', 'account');--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notifications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"role" "user_role" NOT NULL,
	"type" "notification_type" NOT NULL,
	"title" varchar(255) NOT NULL,
	"message" varchar(1000) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "user_roles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"role" "user_role" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"first_name" varchar(255) NOT NULL,
	"last_name" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" varchar(255),
	"avatar_url" varchar(500),
	"bio" text,
	"title" varchar(120),
	"phone" varchar(50),
	"phone_verified" boolean DEFAULT false,
	"email_verified" boolean DEFAULT false,
	"email_verified_at" timestamp,
	"last_login_at" timestamp,
	"password_changed_at" timestamp,
	"onboarded" boolean DEFAULT false,
	"preferences" jsonb DEFAULT '{"theme":"system","locale":"en-US","timezone":"UTC","notifications":{"email":true,"sms":false,"whatsapp":false,"push":true}}'::jsonb,
	"suspended_at" timestamp,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_notifications_user" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_notifications_type" ON "notifications" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_notifications_read_at" ON "notifications" USING btree ("read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_role" ON "user_roles" USING btree ("user_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_role_single_working" ON "user_roles" USING btree ("user_id") WHERE "user_roles"."role" <> 'admin';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_users_email_lower" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "idx_users_deleted_at" ON "users" USING btree ("deleted_at");