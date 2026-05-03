import { describe, expect, it } from 'vitest';
import { parseEmailStream } from '../src/email-parser';

async function parseRaw(raw: string | Uint8Array) {
	const stream = new Response(raw).body;
	if (!stream) throw new Error('Failed to create stream');
	return parseEmailStream(stream);
}

describe('email parser', () => {
	it('parses multipart mail and ignores attachment part', async () => {
		const boundary = '----boundary123';
		const raw = [
			'From: Sender <sender@example.com>',
			'To: Receiver <receiver@example.com>',
			'Subject: multipart test',
			`Content-Type: multipart/mixed; boundary="${boundary}"`,
			'',
			`--${boundary}`,
			'Content-Type: text/plain; charset=utf-8',
			'',
			'plain body',
			`--${boundary}`,
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>html body</p>',
			`--${boundary}`,
			'Content-Type: application/octet-stream',
			'Content-Disposition: attachment; filename="test.bin"',
			'',
			'ignored-binary-content',
			`--${boundary}--`,
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.from).toBe('Sender <sender@example.com>');
		expect(parsed.to).toBe('Receiver <receiver@example.com>');
		expect(parsed.text).toContain('plain body');
		expect(parsed.html).toContain('<p>html body</p>');
	});

	it('parses non-multipart html body', async () => {
		const raw = [
			'From: Sender <sender@example.com>',
			'To: Receiver <receiver@example.com>',
			'Subject: html only',
			'Content-Type: text/html; charset=utf-8',
			'Content-Transfer-Encoding: 7bit',
			'',
			'<h1>Hello</h1>',
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.html).toBe('<h1>Hello</h1>');
		expect(parsed.text).toBeUndefined();
		expect(parsed.htmlCharset).toBe('utf-8');
	});

	it('decodes RFC2047 encoded subject in headers', async () => {
		const raw = [
			'From: Sender <sender@example.com>',
			'To: Receiver <receiver@example.com>',
			'Subject: =?UTF-8?B?5ZWT5piO6aSo?=',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'hello',
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.subject).toBe('啓明館');
		expect(parsed.subjectCharset).toBe('utf-8');
	});

	it('allows overriding body decoder via parser dependencies', async () => {
		const raw = [
			'From: Sender <sender@example.com>',
			'To: Receiver <receiver@example.com>',
			'Subject: dependency injection',
			'Content-Type: text/plain; charset=utf-8',
			'Content-Transfer-Encoding: base64',
			'',
			'aGVsbG8=',
		].join('\r\n');

		const stream = new Response(raw).body;
		if (!stream) throw new Error('Failed to create stream');

		const parsed = await parseEmailStream(stream, {
			decodeBody: () => ({ text: 'decoded by custom dep', charset: 'utf-8' }),
		});

		expect(parsed.text).toBe('decoded by custom dep');
		expect(parsed.textCharset).toBe('utf-8');
	});
});
