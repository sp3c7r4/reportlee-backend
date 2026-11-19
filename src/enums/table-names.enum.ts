/**
 * @info - Centralised table-name constants.
 *         Use these everywhere instead of raw strings so a rename is one edit.
 */
export enum TableNames {
	USERS = "users",
	USER_ROLES = "user_roles",
	NOTIFICATIONS = "notifications",
	WORKSPACES = "workspaces",
	SPACES = "spaces",
	MEMBERSHIPS = "memberships",
	INVITATIONS = "invitations",
	AUDIT_LOGS = "audit_logs",
	WORKSPACE_SCHEDULES = "workspace_schedules",
	REPORTING_PERIODS = "reporting_periods",
	REPORTS = "reports",
	REPORT_REVISIONS = "report_revisions",
	REPORT_EVENTS = "report_events",
	REPORT_COMMENTS = "report_comments",
	TASKS = "tasks",
}
