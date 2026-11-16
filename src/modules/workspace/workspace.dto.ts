import type { Membership } from "@/modules/membership/membership.model";
import type { Workspace } from "./workspace.model";

/** @info - JSON shapes the frontend receives. Every id is a string. Mirrored in the frontend's api-types.ts. */
export interface WorkspaceDto {
	id: string;
	name: string;
	slug: string;
	memberCount: number;
	plan: string;
	memberLimit: number | null;
	aiFeatures: boolean;
	timeZone: string;
	locationTagging: boolean;
	readOnly: boolean;
}

export interface MembershipDto {
	id: string;
	userId: string;
	workspaceId: string;
	role: string;
	space: string | null;
	spaceId: string | null;
}

export const toWorkspaceDto = (
	row: Workspace,
	memberCount: number,
): WorkspaceDto => ({
	id: String(row.id),
	name: row.name,
	slug: row.slug,
	memberCount,
	plan: row.plan,
	memberLimit: row.memberLimit,
	aiFeatures: row.aiFeatures,
	timeZone: row.timeZone,
	locationTagging: row.locationTagging,
	readOnly: row.readOnly,
});

export const toMembershipDto = (
	row: Pick<Membership, "id" | "userId" | "workspaceId" | "role" | "spaceId">,
	spaceName: string | null,
): MembershipDto => ({
	id: String(row.id),
	userId: String(row.userId),
	workspaceId: String(row.workspaceId),
	role: row.role,
	space: spaceName,
	spaceId: row.spaceId === null ? null : String(row.spaceId),
});
