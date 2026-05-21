import {
	ensureWebhookConfigured,
	ensureWebhookSigningConfigured,
	rejectIfMessageTooLarge,
	rejectParsingError,
	rejectWebhookSigningError,
} from './inbound-policy';
import { parseEmailStream } from './email-parser';
import { postWebhook } from './webhook-client';
import { buildWebhookPayload, payloadToFormData } from './webhook-payload-builder';
import type { ParsedResult } from './email-parser';

type WorkerEnv = Env & {
	WEBHOOK_URL?: string;
	INBOUND_PARSE_WEBHOOK_PRIVATE_KEY?: string;
	MAX_MESSAGE_SIZE?: number;
};

const PAYLOAD_PREVIEW_PATH = '/internal/payload-preview';

type PayloadPreviewRequest = {
	parsed?: Partial<ParsedResult>;
	message?: {
		from?: string;
		to?: string;
	};
};

function formDataToObject(form: FormData): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of form.entries()) {
		out[key] = String(value);
	}
	return out;
}

export default {
	async fetch(request: Request) {
		const url = new URL(request.url);
		if (url.pathname !== PAYLOAD_PREVIEW_PATH) {
			return new Response('Not Found', { status: 404 });
		}

		if (request.method !== 'POST') {
			return new Response('Method Not Allowed', { status: 405 });
		}

		let body: PayloadPreviewRequest;
		try {
			body = await request.json<PayloadPreviewRequest>();
		} catch (_error) {
			return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
		}

		const parsed: ParsedResult = {
			headers: {},
			...(body.parsed ?? {}),
		};
		const payload = buildWebhookPayload(parsed, body.message ?? {});
		const { form, headerCharsets } = payloadToFormData(payload);

		return Response.json({
			payload,
			headerCharsets,
			formFields: formDataToObject(form),
		});
	},

	async email(message, env: WorkerEnv, ctx) {
		console.info('email.received', { from: message.from, to: message.to, rawSize: (message as any).rawSize });

		if (!ensureWebhookConfigured(message, env.WEBHOOK_URL)) return;
		if (!ensureWebhookSigningConfigured(message, env.INBOUND_PARSE_WEBHOOK_PRIVATE_KEY)) return;

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
		const headerCharsets = payload.charsets as Record<string, string>;

		console.info('email.parsed', {
			from: parsed.from ?? message.from,
			to: parsed.to ?? message.to,
			subject: parsed.subject,
			charsets: headerCharsets,
		});

		try {
			await postWebhook(env.WEBHOOK_URL, payload, env.INBOUND_PARSE_WEBHOOK_PRIVATE_KEY);
		} catch (e) {
			rejectWebhookSigningError(message, e);
		}
	},
} satisfies ExportedHandler<WorkerEnv>;
