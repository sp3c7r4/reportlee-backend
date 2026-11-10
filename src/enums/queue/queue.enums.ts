export enum QueueNames {
	EMAIL = "email",
}

export enum JobNames {
	SEND_EMAIL = "send-email-job",
}

/** @info - One name per Handlebars template under src/emails. */
export enum EmailJobNames {
	WELCOME = "welcome",
	RESET_PASSWORD = "reset-password",
	VERIFY_OTP = "verify-otp",
}
