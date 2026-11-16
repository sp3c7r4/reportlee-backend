import type { Tx } from "@/db/postgres.db";
import { throwUnprocessableError } from "@/helpers/errors";
import type { Workspace } from "./workspace.model";
import { seatsUsed } from "./workspace.repository";

export const seatLimitMessage = (used: number, limit: number) =>
	`This Workspace is at its member limit (${used} of ${limit} seats used).`;

export class SeatService {
	private static instance: SeatService;

	static getInstance() {
		if (!this.instance) this.instance = new SeatService();
		return this.instance;
	}

	private constructor() {}

	/**
	 * @info - Call inside the Workspace lock (D6) with the locked row, so two requests cannot both
	 * take the last seat. Seats are active members plus pending, unexpired invitations. A null
	 * `memberLimit` means no limit.
	 */
	assertSeat = async (tx: Tx, workspace: Workspace, extra: number) => {
		if (workspace.memberLimit === null) return;
		const used = await seatsUsed(tx, workspace.id);
		if (used + extra > workspace.memberLimit) {
			return throwUnprocessableError(
				seatLimitMessage(used, workspace.memberLimit),
			);
		}
	};
}
