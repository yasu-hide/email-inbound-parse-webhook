import { createWebhookSignatureHeaders } from './webhook-signature';
import type { WebhookPayload } from './webhook-payload-builder';

type SerializedMultipart = {
	body: ArrayBuffer;
	contentType: string;
};

const textEncoder = new TextEncoder();

function concatBytes(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const out = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(out).set(bytes);
	return out;
}

function appendPart(parts: Uint8Array[], boundary: string, name: string, value: Uint8Array, charset = 'utf-8') {
	parts.push(textEncoder.encode(
		`--${boundary}\r\n`
		+ `Content-Disposition: form-data; name="${name}"\r\n`
		+ `Content-Type: text/plain; charset=${charset}\r\n\r\n`,
	));
	parts.push(value);
	parts.push(textEncoder.encode('\r\n'));
}

function isUtf8Charset(charset: string | undefined): boolean {
	return !charset || charset.toLowerCase() === 'utf-8';
}

function bodyFieldBytes(payload: WebhookPayload, field: 'text' | 'html'): Uint8Array | undefined {
	const value = payload[field];
	if (!value) return undefined;

	const bytes = field === 'text' ? payload.textBytes : payload.htmlBytes;
	if (bytes) return bytes;

	const charset = payload.charsets[field];
	if (!isUtf8Charset(charset)) {
		throw new Error(`Missing raw bytes for non-UTF-8 ${field} field.`);
	}
	return textEncoder.encode(value);
}

export function serializeWebhookMultipart(payload: WebhookPayload): SerializedMultipart {
	const boundary = `----email-inbound-parse-${crypto.randomUUID()}`;
	const parts: Uint8Array[] = [];

	appendPart(parts, boundary, 'from', textEncoder.encode(payload.from));
	appendPart(parts, boundary, 'to', textEncoder.encode(payload.to));
	appendPart(parts, boundary, 'subject', textEncoder.encode(payload.subject));
	if (payload.cc) {
		appendPart(parts, boundary, 'cc', textEncoder.encode(payload.cc));
	}

	const textBytes = bodyFieldBytes(payload, 'text');
	if (textBytes) {
		appendPart(parts, boundary, 'text', textBytes, payload.charsets.text || 'utf-8');
	}

	const htmlBytes = bodyFieldBytes(payload, 'html');
	if (htmlBytes) {
		appendPart(parts, boundary, 'html', htmlBytes, payload.charsets.html || 'utf-8');
	}

	appendPart(parts, boundary, 'charsets', textEncoder.encode(JSON.stringify(payload.charsets)));
	parts.push(textEncoder.encode(`--${boundary}--\r\n`));

	const body = concatBytes(parts);
	return {
		body: toArrayBuffer(body),
		contentType: `multipart/form-data; boundary=${boundary}`,
	};
}

export async function postWebhook(webhookUrl: string, payload: WebhookPayload, privateKey: string): Promise<void> {
	const { body, contentType } = serializeWebhookMultipart(payload);
	const signatureHeaders = await createWebhookSignatureHeaders({
		privateKey,
		rawBody: body,
	});

	try {
		const res = await fetch(webhookUrl, {
			method: 'POST',
			headers: {
				'content-type': contentType,
				...signatureHeaders,
			},
			body,
		});
		if (res.ok) {
			console.info('webhook.post_success', { status: res.status });
		} else {
			console.error('webhook.post_failure', { status: res.status });
		}
	} catch (e) {
		console.error('webhook.post_error', { error: String(e) });
	}
}
