import { ensureWebhookConfigured, rejectIfMessageTooLarge, rejectParsingError } from './inbound-policy';
import { parseEmailStream } from './email-parser';
import { postWebhook } from './webhook-client';
import { buildWebhookPayload, payloadToFormData } from './webhook-payload-builder';

type WorkerEnv = Env & {
	WEBHOOK_URL?: string;
	MAX_MESSAGE_SIZE?: number;
};

export default {
	async email(message, env: WorkerEnv, ctx) {
		console.info('email.received', { from: message.from, to: message.to, rawSize: (message as any).rawSize });

		if (!ensureWebhookConfigured(message, env.WEBHOOK_URL)) return;

		const MAX = typeof env.MAX_MESSAGE_SIZE === 'number' ? env.MAX_MESSAGE_SIZE : 10 * 1024 * 1024;
		if (rejectIfMessageTooLarge(message, MAX)) return;

		let parsed;
		try {
			parsed = await parseEmailStream(message.raw as ReadableStream);
		} catch (e) {
			rejectParsingError(message, e);
			return;
		}

		const payload = buildWebhookPayload(parsed, {
			from: message.from,
			to: message.to,
		});
		const { form, headerCharsets } = payloadToFormData(payload);

		console.info('email.parsed', {
			from: parsed.from ?? message.from,
			to: parsed.to ?? message.to,
			subject: parsed.subject,
			charsets: headerCharsets,
		});

		await postWebhook(env.WEBHOOK_URL, form);
	},
} satisfies ExportedHandler<WorkerEnv>;
