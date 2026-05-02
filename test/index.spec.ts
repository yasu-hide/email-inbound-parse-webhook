import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src';

type TestMessage = {
	from: string;
	to: string;
	raw: ReadableStream;
	rawSize: number;
	setReject: ReturnType<typeof vi.fn>;
};

type RawEmailInput = string | Uint8Array;

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
	const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
	vi.stubGlobal('fetch', fetchMock);

	const msg = createMessage(raw);
	const ctx = createExecutionContext();

	await worker.email(msg as any, { WEBHOOK_URL: 'https://example.test/webhook' } as any, ctx);
	await waitOnExecutionContext(ctx);

	expect(msg.setReject).not.toHaveBeenCalled();
	expect(fetchMock).toHaveBeenCalledTimes(1);

	const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
	expect(init.body).toBeInstanceOf(FormData);
	return init.body as FormData;
}

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
		const form = await runEmailWithRaw(raw);
		expect(form.get('text')).toBe('日本語テキスト');

		const charsetsRaw = form.get('charsets');
		expect(typeof charsetsRaw).toBe('string');
		const charsets = JSON.parse(String(charsetsRaw)) as Record<string, string>;
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

		const form = await runEmailWithRaw(raw);
		expect(form.get('text')).toBe('こんにちは');

		const charsetsRaw = form.get('charsets');
		expect(typeof charsetsRaw).toBe('string');
		const charsets = JSON.parse(String(charsetsRaw)) as Record<string, string>;
		expect(charsets.text).toBe('iso-2022-jp');
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
