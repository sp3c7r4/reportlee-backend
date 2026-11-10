import { config } from "@dotenvx/dotenvx";
import { ZodError, z } from "zod";

const getEnvFile = () => `.env.${process.env.NODE_ENV || "development"}`;
const envFile = getEnvFile();

config({ path: envFile, override: true });

/**
 * @info - Every variable the app reads. Parsed once, at boot: a missing value stops
 * the process here, with a line per problem, rather than surfacing as an undefined
 * halfway through a request.
 */
const EnvSchema = z.object({
	NODE_ENV: z.enum(["development", "production", "staging", "test"]),

	PORT: z.coerce.number().default(5000),
	HOSTNAME: z.string().default("0.0.0.0"),
	SERVER_DOMAIN: z.string().default("localhost"),
	ROOT_DOMAIN: z.string().default("http://localhost:3000"),
	FRONTEND_URL: z.string().default("http://localhost:3000"),
	ORIGINS: z
		.string()
		.default('["http://localhost:3000"]')
		.transform((value) => {
			const parsed = JSON.parse(value);
			if (!Array.isArray(parsed)) throw new Error("ORIGINS must be an array");
			return parsed as string[];
		}),

	POSTGRES_URI: z.string(),
	REDIS_URI: z.string(),
	/* @info - Prefixes Redis pub/sub channels. Pub/sub is NOT scoped by Redis db
	 * index, so two environments sharing one Redis would cross-talk on identical
	 * channel names. Production leaves this empty. */
	REDIS_CHANNEL_PREFIX: z.string().default(""),

	JWT_PRIVATE_KEY: z.string(),
	JWT_PUBLIC_KEY: z.string(),
	JWT_EXPIRES_IN: z.string().default("15m"),
	JWT_ISSUER: z.string().default("api"),

	/* @info - 32-byte key, hex or base64, for the at-rest encryption of values the
	 * database should not hold in the clear (see EncryptionService). */
	ENCRYPTION_KEY: z.string(),

	/* @info - Mail. MAIL_PROVIDER picks the transport; both sets of credentials can
	 * sit in the environment so switching is one value and a restart. */
	MAIL_PROVIDER: z.enum(["ses", "resend"]).default("resend"),
	MAIL_DOMAIN: z.string(),
	MAIL_FROM_NAME: z.string().default("My App"),
	/* @info - Absolute URL of the mark every email header shows. Empty means the
	 * header renders without an image rather than with a broken one. */
	MAIL_LOGO_URL: z.string().default(""),
	RESEND_API_KEY: z.string().optional(),
	RESEND_DOMAIN: z.string().optional(),

	AWS_REGION: z.string().default("eu-west-1"),
	AWS_ACCESS_KEY_ID: z.string(),
	AWS_SECRET_ACCESS_KEY: z.string(),
	AWS_S3_BUCKET: z.string(),
	AWS_S3_ENDPOINT: z.string().optional(),
	CDN_URL: z.string().default(""),
});

export type EnvType = z.infer<typeof EnvSchema>;

let _env: EnvType;

try {
	_env = EnvSchema.parse(process.env) as EnvType;
} catch (e) {
	if (e instanceof ZodError) {
		for (const issue of e.issues) {
			const key = issue.path.join(".");
			console.log(`❌ ${key} is missing or invalid: ${issue.message}`);
		}
	} else {
		const message = e instanceof Error ? e.message : String(e);
		console.log(`Error occurred: ${message}`);
	}
	process.exit(1);
}

export const env = _env!;

console.log("[ENV] using environment file:", envFile);
