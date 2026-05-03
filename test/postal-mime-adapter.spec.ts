import { describe, expect, it } from 'vitest';
import { parseEmailStreamWithPostalMime } from '../src/email-parser/postal-mime-adapter';

async function parseRaw(raw: string | Uint8Array) {
	const stream = new Response(raw).body;
	if (!stream) throw new Error('Failed to create stream');
	return parseEmailStreamWithPostalMime(stream);
}

describe('postal-mime adapter', () => {
	it('maps multipart email to ParsedResult fields', async () => {
		const boundary = '----postal-mime-adapter';
		const raw = [
			'From: Sender <sender@example.com>',
			'To: Receiver <receiver@example.com>',
			'Cc: Carbon Copy <cc@example.com>',
			'Subject: adapter mapping',
			`Content-Type: multipart/alternative; boundary="${boundary}"`,
			'',
			`--${boundary}`,
			'Content-Type: text/plain; charset=utf-8',
			'',
			'plain adapter body',
			`--${boundary}`,
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>html adapter body</p>',
			`--${boundary}--`,
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.from).toBe('Sender <sender@example.com>');
		expect(parsed.to).toBe('Receiver <receiver@example.com>');
		expect(parsed.cc).toBe('Carbon Copy <cc@example.com>');
		expect(parsed.subject).toBe('adapter mapping');
		expect(parsed.text).toContain('plain adapter body');
		expect(parsed.html).toContain('<p>html adapter body</p>');
		expect(parsed.fromCharset).toBe('utf-8');
		expect(parsed.toCharset).toBe('utf-8');
		expect(parsed.ccCharset).toBe('utf-8');
		expect(parsed.subjectCharset).toBe('utf-8');
		expect(parsed.textCharset).toBe('utf-8');
		expect(parsed.htmlCharset).toBe('utf-8');
		expect(parsed.headers.subject).toBe('adapter mapping');
		expect(parsed.rawHeaders?.subject).toBe('adapter mapping');
	});

	it('keeps decoded RFC2047 subject and display names', async () => {
		const raw = [
			'From: =?UTF-8?B?5ZWT5piO6aSo?= <sender@example.com>',
			'To: =?UTF-8?B?5Y+X5L+h6ICF?= <receiver@example.com>',
			'Subject: =?UTF-8?B?5ZWT5piO6aSo?=',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'hello',
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.from).toBe('啓明館 <sender@example.com>');
		expect(parsed.to).toBe('受信者 <receiver@example.com>');
		expect(parsed.subject).toBe('啓明館');
		expect(parsed.text).toBe('hello');
	});
});
