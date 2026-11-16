import { z } from "zod";
import { idString } from "@/helpers/id-schema";

export const lastWorkspaceSchema = z.strictObject({
	workspaceId: idString,
});
