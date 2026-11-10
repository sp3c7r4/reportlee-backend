/** @info - The roles a Membership can hold. Add yours here and in the guard calls;
 * the pg enum and the JWT claim both read from this one list. */
export enum UserRole {
	ADMIN = "admin",
	MEMBER = "member",
}
