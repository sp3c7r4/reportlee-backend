import { BaseQueueService } from "@/bases/services/base.queue.service";
import { type EmailTemplates, QueueNames } from "@/enums";

export interface EmailJobData<L> {
	message: {
		to: string;
		subject: string;
		text?: string;
		cc?: string[];
		bcc?: string[];
		replyTo?: string;
	};
	template: EmailTemplates;
	locals: L;
	identifier?: string;
	idempotencyKey?: string;
}

export class EmailQueueService extends BaseQueueService<EmailJobData<any>> {
	private static instance: EmailQueueService;

	private constructor() {
		super({
			queueName: QueueNames.EMAIL,
			alias: "EmailQueue",
			// no priority - prioritized jobs were never drained to wait in prod
			/* @info - A failed send is retried 5 times, waiting 5s, 10s, 20s, 40s: long enough
			 * to ride out an SMTP blip, short enough that an OTP (10 min) is still valid. */
			args: {
				attempts: 5,
				backoff: { type: "exponential", delay: 5000 },
			},
		});
	}

	static getInstance(): EmailQueueService {
		if (!this.instance) {
			this.instance = new EmailQueueService();
		}
		return this.instance;
	}
}
