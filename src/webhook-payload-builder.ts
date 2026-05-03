import type { ParsedResult } from './email-parser';

type DeliveryMessage = {
	from?: string;
	to?: string;
};

export function buildWebhookFormData(parsed: ParsedResult, message: DeliveryMessage): { form: FormData; headerCharsets: Record<string, string> } {
	const form = new FormData();
	const headerCharsets: Record<string, string> = {};

	form.append('from', parsed.from ?? message.from ?? '');
	headerCharsets['from'] = parsed.from ?? message.from ? 'utf-8' : '';

	form.append('to', parsed.to ?? message.to ?? '');
	headerCharsets['to'] = parsed.to ?? message.to ? 'utf-8' : '';

	form.append('subject', parsed.subject ?? '');
	headerCharsets['subject'] = parsed.subject ? 'utf-8' : '';

	if (parsed.cc) {
		form.append('cc', parsed.cc);
		headerCharsets['cc'] = 'utf-8';
	}

	if (parsed.text) {
		form.append('text', parsed.text);
		headerCharsets['text'] = parsed.textCharset || '';
	}

	if (parsed.html) {
		form.append('html', parsed.html);
		headerCharsets['html'] = parsed.htmlCharset || '';
	}

	form.append('charsets', JSON.stringify(headerCharsets));
	return { form, headerCharsets };
}