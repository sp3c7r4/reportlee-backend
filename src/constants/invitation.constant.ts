/*
 * @file Invitation limits
 * @description Invitations one Workspace, and the whole platform, may create per rolling 24 hours.
 * The platform cap protects the shared mail sender (about 500 emails a day, shared with signup
 * and login codes).
 */
export const INVITE_DAILY_LIMIT_PER_WORKSPACE = 70;
export const INVITE_DAILY_LIMIT_PLATFORM = 300;
