import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src';
import {
	WEBHOOK_SIGNATURE_HEADER,
	WEBHOOK_TIMESTAMP_HEADER,
	buildSignedPayload,
} from '../src/webhook-signature';

type TestMessage = {
	from: string;
	to: string;
	raw: ReadableStream;
	rawSize: number;
	setReject: ReturnType<typeof vi.fn>;
};

type RawEmailInput = string | Uint8Array;

type RunEmailOptions = {
	env?: Record<string, unknown>;
	fetchImpl?: ReturnType<typeof vi.fn>;
};

let testPrivateKey = '';
let testPublicKey: CryptoKey;

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function arrayBufferToPem(label: string, buffer: ArrayBuffer): string {
	const base64 = bytesToBase64(new Uint8Array(buffer));
	const lines = base64.match(/.{1,64}/g)?.join('\n') ?? '';
	return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function derToP1363(der: Uint8Array): Uint8Array {
	if (der[0] !== 0x30) throw new Error('Expected DER sequence');
	let offset = 2;

	const readInteger = () => {
		if (der[offset++] !== 0x02) throw new Error('Expected DER integer');
		const length = der[offset++];
		let value = der.slice(offset, offset + length);
		offset += length;
		while (value.length > 1 && value[0] === 0) {
			value = value.slice(1);
		}
		if (value.length > 32) throw new Error('Integer does not fit P-256');

		const padded = new Uint8Array(32);
		padded.set(value, 32 - value.length);
		return padded;
	};

	const signature = new Uint8Array(64);
	signature.set(readInteger(), 0);
	signature.set(readInteger(), 32);
	return signature;
}

async function createTestSigningKey() {
	const pair = await crypto.subtle.generateKey(
		{ name: 'ECDSA', namedCurve: 'P-256' },
		true,
		['sign', 'verify'],
	) as CryptoKeyPair;
	const [privateKey, publicKey] = await Promise.all([
		crypto.subtle.exportKey('pkcs8', pair.privateKey) as Promise<ArrayBuffer>,
		crypto.subtle.exportKey('spki', pair.publicKey) as Promise<ArrayBuffer>,
	]);

	testPrivateKey = arrayBufferToPem('PRIVATE KEY', privateKey);
	testPublicKey = await crypto.subtle.importKey(
		'spki',
		publicKey,
		{ name: 'ECDSA', namedCurve: 'P-256' },
		false,
		['verify'],
	);
}

async function readWebhookRequest(fetchMock: ReturnType<typeof vi.fn>) {
	const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
	const headers = new Headers(init.headers);
	const body = init.body as ArrayBuffer;
	const form = await new Response(body.slice(0), { headers }).formData();

	return {
		url,
		init,
		headers,
		body,
		form,
	};
}

function readWebhookRequestRaw(fetchMock: ReturnType<typeof vi.fn>) {
	const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
	const headers = new Headers(init.headers);
	const body = init.body as ArrayBuffer;
	return { url, init, headers, body };
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
	return indexOfBytes(haystack, needle) !== -1;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, fromIndex = 0): number {
	if (needle.length === 0) return fromIndex;
	for (let i = fromIndex; i <= haystack.length - needle.length; i += 1) {
		let matched = true;
		for (let j = 0; j < needle.length; j += 1) {
			if (haystack[i + j] !== needle[j]) {
				matched = false;
				break;
			}
		}
		if (matched) return i;
	}
	return -1;
}

function binaryStringToBytes(value: string): Uint8Array {
	const bytes = new Uint8Array(value.length);
	for (let i = 0; i < value.length; i += 1) {
		bytes[i] = value.charCodeAt(i) & 0xff;
	}
	return bytes;
}

function extractMultipartFieldBytes(body: ArrayBuffer, contentType: string, name: string): Uint8Array {
	const boundary = contentType.match(/boundary=([^;]+)/)?.[1];
	if (!boundary) throw new Error('Missing multipart boundary');

	const bodyBytes = new Uint8Array(body);
	const boundaryBytes = new TextEncoder().encode(`--${boundary}`);
	const nameBytes = new TextEncoder().encode(`name="${name}"`);
	const crlfHeaderEnd = new Uint8Array([13, 10, 13, 10]);
	const lfHeaderEnd = new Uint8Array([10, 10]);

	let boundaryIndex = indexOfBytes(bodyBytes, boundaryBytes);
	while (boundaryIndex !== -1) {
		const sectionStart = boundaryIndex + boundaryBytes.length;
		const nextBoundaryIndex = indexOfBytes(bodyBytes, boundaryBytes, sectionStart);
		if (nextBoundaryIndex === -1) break;

		const section = bodyBytes.slice(sectionStart, nextBoundaryIndex);
		if (containsBytes(section, nameBytes)) {
			let headerEnd = indexOfBytes(section, crlfHeaderEnd);
			let separatorLength = crlfHeaderEnd.length;
			if (headerEnd === -1) {
				headerEnd = indexOfBytes(section, lfHeaderEnd);
				separatorLength = lfHeaderEnd.length;
			}
			if (headerEnd === -1) throw new Error(`Missing multipart separator for ${name}`);

			let value = section.slice(headerEnd + separatorLength);
			if (value.length >= 2 && value[value.length - 2] === 13 && value[value.length - 1] === 10) {
				value = value.slice(0, value.length - 2);
			} else if (value.length >= 1 && value[value.length - 1] === 10) {
				value = value.slice(0, value.length - 1);
			}
			return value;
		}

		boundaryIndex = nextBoundaryIndex;
	}
	throw new Error(`Missing multipart field ${name}`);
}

function buildRawEmail(
	subjectHeader: string,
	fromHeader = 'Sender <sender@example.com>',
	toHeader = 'Receiver <receiver@example.com>',
	ccHeader?: string,
): string {
	const headers = [
		`From: ${fromHeader}`,
		`To: ${toHeader}`,
		`Subject: ${subjectHeader}`,
		`Content-Type: text/plain; charset=utf-8`,
		`Content-Transfer-Encoding: 7bit`,
	];
	if (ccHeader) headers.splice(2, 0, `Cc: ${ccHeader}`);
	return [...headers, ``, `hello`].join('\r\n');
}

function createMessage(rawEmail: RawEmailInput): TestMessage {
	const body = new Response(rawEmail).body;
	if (!body) throw new Error('Failed to create test stream');

	return {
		from: 'sender@example.com',
		to: 'receiver@example.com',
		raw: body,
		rawSize: typeof rawEmail === 'string' ? rawEmail.length : rawEmail.byteLength,
		setReject: vi.fn(),
	};
}

async function runEmailWithSubject(subjectHeader: string): Promise<FormData> {
	return runEmailWithRaw(buildRawEmail(subjectHeader));
}

async function runEmailWithRaw(raw: RawEmailInput): Promise<FormData> {
	const { fetchMock, msg } = await runEmail(raw);

	expect(msg.setReject).not.toHaveBeenCalled();
	expect(fetchMock).toHaveBeenCalledTimes(1);

	const { form } = await readWebhookRequest(fetchMock);
	return form;
}

async function runEmail(raw: RawEmailInput, options: RunEmailOptions = {}) {
	const fetchMock = options.fetchImpl ?? vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
	vi.stubGlobal('fetch', fetchMock);

	const msg = createMessage(raw);
	const ctx = createExecutionContext();
	const env = {
		WEBHOOK_URL: 'https://example.test/webhook',
		INBOUND_PARSE_WEBHOOK_PRIVATE_KEY: testPrivateKey,
		...(options.env ?? {}),
	} as any;

	await worker.email(msg as any, env, ctx);
	await waitOnExecutionContext(ctx);

	return { fetchMock, msg };
}

async function runFetch(request: Request): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await (worker.fetch as (request: Request, env: unknown, ctx: ExecutionContext) => Promise<Response>)(request, {} as any, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

beforeAll(async () => {
	await createTestSigningKey();
});

describe('email worker subject decoding', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('decodes RFC2047 base64 UTF-8 subject', async () => {
		const form = await runEmailWithSubject('=?UTF-8?B?5ZWT5piO6aSo?=');
		expect(form.get('subject')).toBe('啓明館');
	});

	it('decodes RFC2047 Q-encoding UTF-8 subject', async () => {
		const form = await runEmailWithSubject('=?UTF-8?Q?=E5=95=93=E6=98=8E=E9=A4=A8?=');
		expect(form.get('subject')).toBe('啓明館');
	});

	it('decodes folded RFC2047 subject headers', async () => {
		const form = await runEmailWithRaw([
			'From: Sender <sender@example.com>',
			'To: Receiver <receiver@example.com>',
			'Subject: =?UTF-8?B?5ZWT?=',
			' =?UTF-8?B?5piO6aSo?=',
			'Content-Type: text/plain; charset=utf-8',
			'Content-Transfer-Encoding: 7bit',
			'',
			'hello',
		].join('\r\n'));
		expect(form.get('subject')).toBe('啓明館');
	});

	it('keeps malformed encoded-word subject without throwing', async () => {
		const malformed = '=?UTF-8?B?5ZWT5piO6aSo?';
		const form = await runEmailWithRaw(buildRawEmail(malformed));
		expect(form.get('subject')).toBe(malformed);
	});

	it('keeps first subject line when folded header continuation is malformed', async () => {
		const form = await runEmailWithRaw([
			'From: Sender <sender@example.com>',
			'To: Receiver <receiver@example.com>',
			'Subject: valid prefix',
			'broken continuation without colon',
			'Content-Type: text/plain; charset=utf-8',
			'Content-Transfer-Encoding: 7bit',
			'',
			'hello',
		].join('\r\n'));
		expect(form.get('subject')).toBe('valid prefix');
	});

	it('decodes RFC2047 base64 display-name in From and To', async () => {
		const raw = buildRawEmail(
			'=?UTF-8?B?5ZWT5piO6aSo?=',
			'=?UTF-8?B?5ZWT5piO6aSo?= <sender@example.com>',
			'=?UTF-8?B?5Y+X5L+h6ICF?= <receiver@example.com>',
		);
		const form = await runEmailWithRaw(raw);
		expect(form.get('from')).toBe('啓明館 <sender@example.com>');
		expect(form.get('to')).toBe('受信者 <receiver@example.com>');
	});

	it('decodes folded RFC2047 display-name in To header', async () => {
		const raw = buildRawEmail(
			'=?UTF-8?B?5ZWT5piO6aSo?=',
			'Sender <sender@example.com>',
			'=?UTF-8?B?5Y+X?=\r\n =?UTF-8?B?5L+h6ICF?= <receiver@example.com>',
		);
		const form = await runEmailWithRaw(raw);
		expect(form.get('to')).toBe('受信者 <receiver@example.com>');
	});

	it('decodes RFC2047 base64 display-name in Cc header', async () => {
		const raw = buildRawEmail(
			'=?UTF-8?B?5ZWT5piO6aSo?=',
			'Sender <sender@example.com>',
			'Receiver <receiver@example.com>',
			'=?UTF-8?B?5Y+X5L+h6ICF?= <cc@example.com>',
		);
		const form = await runEmailWithRaw(raw);
		expect(form.get('cc')).toBe('受信者 <cc@example.com>');
	});

	it('decodes folded RFC2047 display-name in Cc header', async () => {
		const raw = buildRawEmail(
			'=?UTF-8?B?5ZWT5piO6aSo?=',
			'Sender <sender@example.com>',
			'Receiver <receiver@example.com>',
			'=?UTF-8?B?5Y+X?=\r\n =?UTF-8?B?5L+h6ICF?= <cc@example.com>',
		);
		const form = await runEmailWithRaw(raw);
		expect(form.get('cc')).toBe('受信者 <cc@example.com>');
	});

	it('defaults text charset to utf-8 when Content-Type charset is missing', async () => {
		const raw = [
			'From: Sender <sender@example.com>',
			'To: Receiver <receiver@example.com>',
			'Subject: charset missing',
			'Content-Type: text/plain',
			'Content-Transfer-Encoding: 8bit',
			'',
			'日本語テキスト',
		].join('\r\n');
		const { fetchMock, msg } = await runEmail(raw);
		expect(msg.setReject).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const { headers, body } = readWebhookRequestRaw(fetchMock);
		const contentType = headers.get('content-type') ?? '';
		const textBytes = extractMultipartFieldBytes(body, contentType, 'text');
		expect(new TextDecoder().decode(textBytes)).toBe('日本語テキスト');

		const charsetsBytes = extractMultipartFieldBytes(body, contentType, 'charsets');
		const charsets = JSON.parse(new TextDecoder().decode(charsetsBytes)) as Record<string, string>;
		expect(charsets.from).toBe('utf-8');
		expect(charsets.to).toBe('utf-8');
		expect(charsets.subject).toBe('utf-8');
		expect(charsets.text).toBe('utf-8');
	});

	it('normalizes plain ascii headers as utf-8', async () => {
		const raw = [
			'From: Sender <sender@example.com>',
			'To: Receiver <receiver@example.com>',
			'Subject: no encoded-word',
			'Content-Type: text/plain',
			'Content-Transfer-Encoding: 7bit',
			'',
			'hello',
		].join('\r\n');
		const form = await runEmailWithRaw(raw);

		const charsetsRaw = form.get('charsets');
		expect(typeof charsetsRaw).toBe('string');
		const charsets = JSON.parse(String(charsetsRaw)) as Record<string, string>;
		expect(charsets.from).toBe('utf-8');
		expect(charsets.to).toBe('utf-8');
		expect(charsets.subject).toBe('utf-8');
	});

	it('decodes text body using declared charset', async () => {
		const raw = [
			'From: Sender <sender@example.com>',
			'To: Receiver <receiver@example.com>',
			'Subject: =?ISO-2022-JP?B?GyRCNzxMQDRbRn5CYDw8GyhC?=',
			'Content-Type: text/plain; charset=ISO-2022-JP',
			'Content-Transfer-Encoding: quoted-printable',
			'',
			'=1B$B$3$s$K$A$O=1B(B',
		].join('\r\n');

		const { fetchMock, msg } = await runEmail(raw);
		expect(msg.setReject).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const { headers, body } = readWebhookRequestRaw(fetchMock);
		const contentType = headers.get('content-type') ?? '';
		const textBytes = extractMultipartFieldBytes(body, contentType, 'text');
		const charsetsBytes = extractMultipartFieldBytes(body, contentType, 'charsets');
		const charsets = JSON.parse(new TextDecoder().decode(charsetsBytes)) as Record<string, string>;

		expect(textBytes).toEqual(binaryStringToBytes('\x1B$B$3$s$K$A$O\x1B(B'));
		expect(containsBytes(new Uint8Array(body), new TextEncoder().encode('こんにちは'))).toBe(false);
		expect(charsets.text).toBe('iso-2022-jp');
	});

	it('sends iso-8859-1 text body bytes without UTF-8 re-encoding', async () => {
		const raw = new Uint8Array([
			...new TextEncoder().encode([
				'From: Sender <sender@example.com>',
				'To: Receiver <receiver@example.com>',
				'Subject: latin1 body',
				'Content-Type: text/plain; charset=ISO-8859-1',
				'Content-Transfer-Encoding: 8bit',
				'',
				'caf',
			].join('\r\n')),
			0xe9,
		]);

		const { fetchMock, msg } = await runEmail(raw);
		expect(msg.setReject).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const { headers, body } = readWebhookRequestRaw(fetchMock);
		const contentType = headers.get('content-type') ?? '';
		const textBytes = extractMultipartFieldBytes(body, contentType, 'text');
		const charsetsBytes = extractMultipartFieldBytes(body, contentType, 'charsets');
		const charsets = JSON.parse(new TextDecoder().decode(charsetsBytes)) as Record<string, string>;

		expect(textBytes).toEqual(new Uint8Array([0x63, 0x61, 0x66, 0xe9]));
		expect(containsBytes(textBytes, new Uint8Array([0xc3, 0xa9]))).toBe(false);
		expect(charsets.text).toBe('iso-8859-1');
	});

	it('decodes non-utf8 raw subject header bytes and normalizes charset to utf-8', async () => {
		const raw = new Uint8Array([
			...new TextEncoder().encode('From: Sender <sender@example.com>\r\n'),
			...new TextEncoder().encode('To: Receiver <receiver@example.com>\r\n'),
			...new TextEncoder().encode('Subject: caf'),
			0xe9,
			...new TextEncoder().encode('\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\nhello'),
		]);

		const form = await runEmailWithRaw(raw);
		expect(form.get('subject')).toBe('café');

		const charsetsRaw = form.get('charsets');
		expect(typeof charsetsRaw).toBe('string');
		const charsets = JSON.parse(String(charsetsRaw)) as Record<string, string>;
		expect(charsets.subject).toBe('utf-8');
	});
});

describe('email worker contract', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('rejects when WEBHOOK_URL is missing', async () => {
		const raw = buildRawEmail('missing webhook');
		const { fetchMock, msg } = await runEmail(raw, { env: { WEBHOOK_URL: undefined } });

		expect(msg.setReject).toHaveBeenCalledTimes(1);
		expect(msg.setReject).toHaveBeenCalledWith('WEBHOOK_URL not configured');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects before parsing when webhook signing key is missing', async () => {
		const raw = buildRawEmail('missing signing key');
		const { fetchMock, msg } = await runEmail(raw, {
			env: { INBOUND_PARSE_WEBHOOK_PRIVATE_KEY: undefined },
		});

		expect(msg.setReject).toHaveBeenCalledTimes(1);
		expect(msg.setReject).toHaveBeenCalledWith('INBOUND_PARSE_WEBHOOK_PRIVATE_KEY not configured');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects when message size exceeds MAX_MESSAGE_SIZE', async () => {
		const raw = buildRawEmail('too large');
		const maxSize = raw.length - 1;
		const { fetchMock, msg } = await runEmail(raw, {
			env: {
				WEBHOOK_URL: 'https://example.test/webhook',
				MAX_MESSAGE_SIZE: maxSize,
			},
		});

		expect(msg.setReject).toHaveBeenCalledTimes(1);
		expect(msg.setReject).toHaveBeenCalledWith('Message too large');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('does not reject when message size equals MAX_MESSAGE_SIZE', async () => {
		const raw = buildRawEmail('equal size');
		const { fetchMock, msg } = await runEmail(raw, {
			env: {
				WEBHOOK_URL: 'https://example.test/webhook',
				MAX_MESSAGE_SIZE: raw.length,
			},
		});

		expect(msg.setReject).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('does not reject by size when rawSize is unavailable', async () => {
		const raw = buildRawEmail('no raw size');
		const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		const msg = createMessage(raw) as any;
		delete msg.rawSize;
		const ctx = createExecutionContext();

		await worker.email(msg, {
			WEBHOOK_URL: 'https://example.test/webhook',
			INBOUND_PARSE_WEBHOOK_PRIVATE_KEY: testPrivateKey,
			MAX_MESSAGE_SIZE: 1,
		} as any, ctx);
		await waitOnExecutionContext(ctx);

		expect(msg.setReject).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('falls back to default max size when MAX_MESSAGE_SIZE is non-number', async () => {
		const raw = buildRawEmail('string max size');
		const { fetchMock, msg } = await runEmail(raw, {
			env: {
				WEBHOOK_URL: 'https://example.test/webhook',
				MAX_MESSAGE_SIZE: '1',
			},
		});

		expect(msg.setReject).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('rejects with Parsing error when parser throws', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		const msg = {
			from: 'sender@example.com',
			to: 'receiver@example.com',
			raw: {} as ReadableStream,
			rawSize: 100,
			setReject: vi.fn(),
		};
		const ctx = createExecutionContext();

		await worker.email(msg as any, {
			WEBHOOK_URL: 'https://example.test/webhook',
			INBOUND_PARSE_WEBHOOK_PRIVATE_KEY: testPrivateKey,
		} as any, ctx);
		await waitOnExecutionContext(ctx);

		expect(msg.setReject).toHaveBeenCalledTimes(1);
		expect(msg.setReject).toHaveBeenCalledWith('Parsing error');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('does not reject when webhook returns non-2xx', async () => {
		const raw = buildRawEmail('non 2xx');
		const fetchMock = vi.fn().mockResolvedValue(new Response('bad', { status: 500 }));
		const { msg } = await runEmail(raw, {
			env: { WEBHOOK_URL: 'https://example.test/webhook' },
			fetchImpl: fetchMock,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(msg.setReject).not.toHaveBeenCalled();
	});

	it('does not reject when webhook request throws', async () => {
		const raw = buildRawEmail('network error');
		const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
		const { msg } = await runEmail(raw, {
			env: { WEBHOOK_URL: 'https://example.test/webhook' },
			fetchImpl: fetchMock,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(msg.setReject).not.toHaveBeenCalled();
	});

	it('rejects and does not fetch when webhook signing fails', async () => {
		const raw = buildRawEmail('invalid signing key');
		const { fetchMock, msg } = await runEmail(raw, {
			env: { INBOUND_PARSE_WEBHOOK_PRIVATE_KEY: 'not-a-pem' },
		});

		expect(msg.setReject).toHaveBeenCalledTimes(1);
		expect(msg.setReject).toHaveBeenCalledWith('Webhook signing error');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('sends only X-Email signature headers over the exact serialized multipart body', async () => {
		const raw = buildRawEmail('signed webhook');
		const { fetchMock, msg } = await runEmail(raw);

		expect(msg.setReject).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const { headers, body, form } = await readWebhookRequest(fetchMock);
		const contentType = headers.get('content-type');
		expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
		expect(headers.get(WEBHOOK_SIGNATURE_HEADER)).toEqual(expect.any(String));
		expect(headers.get(WEBHOOK_TIMESTAMP_HEADER)).toMatch(/^\d+$/);
		expect(headers.has('X-Twilio-Email-Event-Webhook-Signature')).toBe(false);
		expect(headers.has('X-Twilio-Email-Event-Webhook-Timestamp')).toBe(false);
		expect(form.get('subject')).toBe('signed webhook');

		const signature = derToP1363(base64ToBytes(headers.get(WEBHOOK_SIGNATURE_HEADER) ?? ''));
		await expect(crypto.subtle.verify(
			{ name: 'ECDSA', hash: 'SHA-256' },
			testPublicKey,
			signature,
			buildSignedPayload(headers.get(WEBHOOK_TIMESTAMP_HEADER) ?? '', body),
		)).resolves.toBe(true);
	});

	it('always sends required payload fields', async () => {
		const raw = [
			'Content-Type: text/plain; charset=utf-8',
			'',
			'hello',
		].join('\r\n');
		const form = await runEmailWithRaw(raw);

		expect(form.get('from')).toBe('sender@example.com');
		expect(form.get('to')).toBe('receiver@example.com');
		expect(form.get('subject')).toBe('');

		const charsetsRaw = form.get('charsets');
		expect(typeof charsetsRaw).toBe('string');
		const charsets = JSON.parse(String(charsetsRaw)) as Record<string, string>;
		expect(charsets.from).toBe('utf-8');
		expect(charsets.to).toBe('utf-8');
		expect(charsets.subject).toBe('');
	});

	it('sends multipart payload fields for text html and cc', async () => {
		const boundary = '----integration-boundary';
		const raw = [
			'From: Sender <sender@example.com>',
			'To: Receiver <receiver@example.com>',
			'Cc: Carbon Copy <cc@example.com>',
			'Subject: multipart integration',
			`Content-Type: multipart/alternative; boundary="${boundary}"`,
			'',
			`--${boundary}`,
			'Content-Type: text/plain; charset=utf-8',
			'',
			'plain integration body',
			`--${boundary}`,
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>html integration body</p>',
			`--${boundary}--`,
		].join('\r\n');

		const form = await runEmailWithRaw(raw);
		expect(form.get('cc')).toBe('Carbon Copy <cc@example.com>');
		expect(form.get('text')).toContain('plain integration body');
		expect(form.get('html')).toContain('<p>html integration body</p>');

		const charsetsRaw = form.get('charsets');
		expect(typeof charsetsRaw).toBe('string');
		const charsets = JSON.parse(String(charsetsRaw)) as Record<string, string>;
		expect(charsets.cc).toBe('utf-8');
		expect(charsets.text).toBe('utf-8');
		expect(charsets.html).toBe('utf-8');
	});

	it('does not reject when multipart boundary declaration does not match body', async () => {
		const declaredBoundary = '----declared-boundary';
		const actualBoundary = '----actual-boundary';
		const raw = [
			'From: Sender <sender@example.com>',
			'To: Receiver <receiver@example.com>',
			'Subject: malformed boundary',
			`Content-Type: multipart/mixed; boundary="${declaredBoundary}"`,
			'',
			`--${actualBoundary}`,
			'Content-Type: text/plain; charset=utf-8',
			'',
			'hello from malformed boundary',
			`--${actualBoundary}--`,
		].join('\r\n');

		const { fetchMock, msg } = await runEmail(raw);
		expect(msg.setReject).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe('fetch payload preview endpoint', () => {
	it('returns payload preview using shared payload builder path', async () => {
		const request = new Request('https://example.test/internal/payload-preview', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				parsed: {
					from: 'Parsed Sender <sender@example.com>',
					to: 'Parsed Receiver <receiver@example.com>',
					subject: 'preview subject',
					text: 'preview body',
					textCharset: 'utf-8',
				},
				message: {
					from: 'fallback-sender@example.com',
					to: 'fallback-receiver@example.com',
				},
			}),
		});

		const response = await runFetch(request);
		expect(response.status).toBe(200);

		const json = await response.json<any>();
		expect(json.payload.from).toBe('Parsed Sender <sender@example.com>');
		expect(json.payload.to).toBe('Parsed Receiver <receiver@example.com>');
		expect(json.payload.subject).toBe('preview subject');
		expect(json.payload.text).toBe('preview body');
		expect(json.headerCharsets).toEqual({
			from: 'utf-8',
			to: 'utf-8',
			subject: 'utf-8',
			text: 'utf-8',
		});
		expect(json.formFields.from).toBe('Parsed Sender <sender@example.com>');
		expect(json.formFields.to).toBe('Parsed Receiver <receiver@example.com>');
		expect(json.formFields.subject).toBe('preview subject');
		expect(json.formFields.text).toBe('preview body');
	});

	it('returns 400 when payload preview body is invalid json', async () => {
		const request = new Request('https://example.test/internal/payload-preview', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{broken',
		});

		const response = await runFetch(request);
		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({ error: 'Invalid JSON body' });
	});

	it('returns 405 for non-POST request on payload preview endpoint', async () => {
		const request = new Request('https://example.test/internal/payload-preview', { method: 'GET' });
		const response = await runFetch(request);
		expect(response.status).toBe(405);
	});

	it('returns 404 for unknown fetch route', async () => {
		const request = new Request('https://example.test/unknown', { method: 'POST' });
		const response = await runFetch(request);
		expect(response.status).toBe(404);
	});
});
