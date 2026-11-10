import { env } from "./env";

export const config = {
	env: env.NODE_ENV,

	jwt: {
		privateKey: env.JWT_PRIVATE_KEY,
		publicKey: env.JWT_PUBLIC_KEY,
		expiresIn: env.JWT_EXPIRES_IN,
		issuer: env.JWT_ISSUER,
	},

	db: {
		uri: env.POSTGRES_URI,
	},

	redis: {
		uri: env.REDIS_URI,
		channelPrefix: env.REDIS_CHANNEL_PREFIX,
	},

	mail: {
		domain: env.MAIL_DOMAIN,
		fromName: env.MAIL_FROM_NAME,
		logoUrl: env.MAIL_LOGO_URL,
		provider: env.MAIL_PROVIDER,
	},

	aws: {
		region: env.AWS_REGION,
		accessKeyId: env.AWS_ACCESS_KEY_ID,
		secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
		s3Bucket: env.AWS_S3_BUCKET,
		s3Endpoint: env.AWS_S3_ENDPOINT,
		resend: {
			apiKey: env.RESEND_API_KEY ?? "",
			domain: env.RESEND_DOMAIN ?? env.MAIL_DOMAIN,
		},
	},

	cdn: {
		url: env.CDN_URL,
	},

	server: {
		hostname: env.HOSTNAME,
		port: env.PORT,
		serverDomain: env.SERVER_DOMAIN,
		rootDomain: env.ROOT_DOMAIN,
		origins: env.ORIGINS,
	},

	frontendUrl: env.FRONTEND_URL,

	encryption: {
		key: env.ENCRYPTION_KEY,
	},

	getEnvUrl: () =>
		config.env === "development"
			? `http://127.0.0.1:${config.server.port}`
			: `https://${config.server.serverDomain}`,
};
