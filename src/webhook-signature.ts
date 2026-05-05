export const WEBHOOK_SIGNATURE_HEADER = 'X-Email-Event-Webhook-Signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'X-Email-Event-Webhook-Timestamp';

const privateKeyCache = new Map<string, Promise<CryptoKey>>();
const textEncoder = new TextEncoder();
const pkcs8PemLabel = ['PRIVATE', 'KEY'].join(' ');
const pkcs8PemBegin = `-----BEGIN ${pkcs8PemLabel}-----`;
const pkcs8PemEnd = `-----END ${pkcs8PemLabel}-----`;

export class WebhookSignatureError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WebhookSignatureError';
	}
}

export type WebhookSignatureHeaders = {
	[WEBHOOK_SIGNATURE_HEADER]: string;
	[WEBHOOK_TIMESTAMP_HEADER]: string;
};

export function normalizePrivateKeyPem(privateKey?: string): string {
	const normalized = privateKey?.replace(/\\n/g, '\n').trim() ?? '';
	if (!normalized) {
		throw new WebhookSignatureError('INBOUND_PARSE_WEBHOOK_PRIVATE_KEY not configured');
	}
	if (!normalized.includes(pkcs8PemBegin) || !normalized.includes(pkcs8PemEnd)) {
		throw new WebhookSignatureError('INBOUND_PARSE_WEBHOOK_PRIVATE_KEY must be a PKCS#8 PEM private key');
	}
	return normalized;
}

export function pemToArrayBuffer(pem: string): ArrayBuffer {
	const base64 = pem
		.replace(pkcs8PemBegin, '')
		.replace(pkcs8PemEnd, '')
		.replace(/\s/g, '');
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

export async function importSigningKey(privateKey: string): Promise<CryptoKey> {
	const pem = normalizePrivateKeyPem(privateKey);
	const cached = privateKeyCache.get(pem);
	if (cached) return cached;

	let imported: Promise<CryptoKey>;
	try {
		imported = crypto.subtle.importKey(
			'pkcs8',
			pemToArrayBuffer(pem),
			{ name: 'ECDSA', namedCurve: 'P-256' },
			false,
			['sign'],
		);
	} catch (error) {
		throw new WebhookSignatureError(`Failed to import webhook signing key: ${String(error)}`);
	}
	privateKeyCache.set(pem, imported);

	try {
		return await imported;
	} catch (error) {
		privateKeyCache.delete(pem);
		throw new WebhookSignatureError(`Failed to import webhook signing key: ${String(error)}`);
	}
}

export function buildSignedPayload(timestamp: string, rawBody: ArrayBuffer): Uint8Array {
	const timestampBytes = textEncoder.encode(timestamp);
	const bodyBytes = new Uint8Array(rawBody);
	const payload = new Uint8Array(timestampBytes.length + bodyBytes.length);
	payload.set(timestampBytes, 0);
	payload.set(bodyBytes, timestampBytes.length);
	return payload;
}

function normalizeDerInteger(bytes: Uint8Array): Uint8Array {
	let start = 0;
	while (start < bytes.length - 1 && bytes[start] === 0) {
		start += 1;
	}

	const value = bytes.slice(start);
	if ((value[0] & 0x80) === 0) return value;

	const prefixed = new Uint8Array(value.length + 1);
	prefixed.set(value, 1);
	return prefixed;
}

export function p1363ToDer(signature: ArrayBuffer): Uint8Array {
	const bytes = new Uint8Array(signature);
	if (bytes.length !== 64) {
		throw new WebhookSignatureError(`Expected P-256 ECDSA signature to be 64 bytes, got ${bytes.length}`);
	}

	const r = normalizeDerInteger(bytes.slice(0, 32));
	const s = normalizeDerInteger(bytes.slice(32));
	const sequenceLength = 2 + r.length + 2 + s.length;
	if (sequenceLength > 127) {
		throw new WebhookSignatureError('ECDSA signature is too large to encode as short-form DER');
	}

	const der = new Uint8Array(2 + sequenceLength);
	let offset = 0;
	der[offset++] = 0x30;
	der[offset++] = sequenceLength;
	der[offset++] = 0x02;
	der[offset++] = r.length;
	der.set(r, offset);
	offset += r.length;
	der[offset++] = 0x02;
	der[offset++] = s.length;
	der.set(s, offset);
	return der;
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

export async function createWebhookSignatureHeaders({
	privateKey,
	rawBody,
	nowMs = Date.now(),
}: {
	privateKey: string;
	rawBody: ArrayBuffer;
	nowMs?: number;
}): Promise<WebhookSignatureHeaders> {
	const timestamp = Math.floor(nowMs / 1000).toString();
	const key = await importSigningKey(privateKey);
	const signedPayload = buildSignedPayload(timestamp, rawBody);
	const signature = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		key,
		signedPayload,
	);

	return {
		[WEBHOOK_SIGNATURE_HEADER]: bytesToBase64(p1363ToDer(signature)),
		[WEBHOOK_TIMESTAMP_HEADER]: timestamp,
	};
}
