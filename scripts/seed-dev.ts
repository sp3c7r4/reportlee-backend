/**
 * Dev fixture seeder — one admin and one member you can log in as.
 *
 * Re-runnable: it deletes its own namespace and rebuilds it, so running it twice
 * gives the same rows. Everything it owns is namespaced (`dev-*@example.com`) and it
 * touches nothing else.
 *
 * Run it with `npm run seed:dev` after `npm run migrate`.
 */
import { hash } from "@node-rs/argon2";
import { Pool } from "pg";
import { config } from "@/config";
import { MEMORY_COST, PARALLELISM, TIME_COST } from "@/constants";

const pool = new Pool({ connectionString: config.db.uri });

/** @info - One password for every dev account. It is a local fixture, and needing to
 *         remember four of them is worse than needing to remember one. */
const DEV_PASSWORD = "Dev@1234";
const EMAIL_DOMAIN = "example.com";

const people = [
	{
		firstName: "Ada",
		lastName: "Admin",
		email: `dev-admin@${EMAIL_DOMAIN}`,
		role: "admin",
	},
	{
		firstName: "Sam",
		lastName: "Member",
		email: `dev-member@${EMAIL_DOMAIN}`,
		role: "member",
	},
];

const passwordHash = await hash(DEV_PASSWORD, {
	memoryCost: MEMORY_COST,
	timeCost: TIME_COST,
	parallelism: PARALLELISM,
});

await pool.query("DELETE FROM users WHERE email LIKE $1", [
	`dev-%@${EMAIL_DOMAIN}`,
]);

for (const person of people) {
	const { rows } = await pool.query(
		`INSERT INTO users
			(first_name, last_name, email, password_hash, email_verified, email_verified_at, onboarded)
		 VALUES ($1, $2, $3, $4, true, now(), true)
		 RETURNING id`,
		[person.firstName, person.lastName, person.email, passwordHash],
	);
	const userId = rows[0].id as number;

	await pool.query(
		`INSERT INTO user_roles (user_id, role) VALUES ($1, $2)
		 ON CONFLICT DO NOTHING`,
		[userId, person.role],
	);

	console.log(`  ✓ ${person.role.padEnd(6)} ${person.email}`);
}

await pool.end();
console.log(`\nDev accounts ready. Password for all: ${DEV_PASSWORD}`);
