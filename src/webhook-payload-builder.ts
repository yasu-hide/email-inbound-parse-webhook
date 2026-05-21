import type { ParsedResult } from './email-parser';

type DeliveryMessage = {
	from?: string;
	to?: string;
};

export type WebhookCharsets = {
	from: string;
	to: string;
	subject: string;
	cc?: string;
	text?: string;
	html?: string;
};

export type WebhookPayload = {
	from: string;
	to: string;
	subject: string;
	cc?: string;
	text?: string;
	textBytes?: Uint8Array;
	html?: string;
	htmlBytes?: Uint8Array;
	charsets: WebhookCharsets;
};

export function buildWebhookPayload(parsed: ParsedResult, message: DeliveryMessage): WebhookPayload {
	const payload: WebhookPayload = {
		from: parsed.from ?? message.from ?? '',
		to: parsed.to ?? message.to ?? '',
		subject: parsed.subject ?? '',
		charsets: {
			from: parsed.from ?? message.from ? 'utf-8' : '',
			to: parsed.to ?? message.to ? 'utf-8' : '',
			subject: parsed.subject ? 'utf-8' : '',
		},
	};

	if (parsed.cc) {
		payload.cc = parsed.cc;
		payload.charsets.cc = 'utf-8';
	}

	if (parsed.text) {
		payload.text = parsed.text;
		payload.textBytes = parsed.textBytes;
		payload.charsets.text = parsed.textCharset || '';
	}

	if (parsed.html) {
		payload.html = parsed.html;
		payload.htmlBytes = parsed.htmlBytes;
		payload.charsets.html = parsed.htmlCharset || '';
	}

	return payload;
}

export function payloadToFormData(payload: WebhookPayload): { form: FormData; headerCharsets: Record<string, string> } {
	const form = new FormData();

	form.append('from', payload.from);
	form.append('to', payload.to);
	form.append('subject', payload.subject);

	if (payload.cc) {
		form.append('cc', payload.cc);
	}

	if (payload.text) {
		form.append('text', payload.text);
	}

	if (payload.html) {
		form.append('html', payload.html);
	}

	const headerCharsets = payload.charsets as Record<string, string>;
	form.append('charsets', JSON.stringify(headerCharsets));

	return { form, headerCharsets };
}

/**
 * @deprecated Prefer buildWebhookPayload + payloadToFormData for new call sites.
 * Keep this wrapper only for compatibility during migration.
 */
export function buildWebhookFormData(parsed: ParsedResult, message: DeliveryMessage): { form: FormData; headerCharsets: Record<string, string> } {
	const payload = buildWebhookPayload(parsed, message);
	return payloadToFormData(payload);
}
