import { buildWebhookFormData, postWebhook } from './email-delivery';
import { parseEmailStream } from './email-parser';

type WorkerEnv = Env & {
	WEBHOOK_URL?: string;
	MAX_MESSAGE_SIZE?: number;
};

function safeSetReject(message: any, reason: string) {
	try {
		message.setReject(reason);
	} catch (err) {
		console.error('setReject failed', String(err));
	}
}

export default {
	async email(message, env: WorkerEnv, ctx) {
		console.info('email.received', { from: message.from, to: message.to, rawSize: (message as any).rawSize });

		if (!env.WEBHOOK_URL) {
			console.error('email.rejected.no_webhook', { from: message.from, to: message.to });
			safeSetReject(message, 'WEBHOOK_URL not configured');
			return;
		}

		const MAX = typeof env.MAX_MESSAGE_SIZE === 'number' ? env.MAX_MESSAGE_SIZE : 10 * 1024 * 1024;
		// @ts-ignore
		if (typeof message.rawSize === 'number' && message.rawSize > MAX) {
			console.warn('email.rejected.too_large', { size: message.rawSize, max: MAX });
			safeSetReject(message, 'Message too large');
			return;
		}

		let parsed;
		try {
			parsed = await parseEmailStream(message.raw as ReadableStream);
		} catch (e) {
			console.error('email.parse_error', { error: String(e) });
			safeSetReject(message, 'Parsing error');
			return;
		}

		const { form, headerCharsets } = buildWebhookFormData(parsed, {
			from: message.from,
			to: message.to,
		});

		console.info('email.parsed', {
			from: parsed.from ?? message.from,
			to: parsed.to ?? message.to,
			subject: parsed.subject,
			charsets: headerCharsets,
		});

		await postWebhook(env.WEBHOOK_URL, form);
	},
} satisfies ExportedHandler<WorkerEnv>;
