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

	it('prefers postal output for healthy multipart/alternative', async () => {
		const boundary = '----healthy-alt';
		const raw = [
			'From: Sender <sender@example.com>',
			'To: Receiver <receiver@example.com>',
			'Subject: healthy alternative',
			`Content-Type: multipart/alternative; boundary="${boundary}"; charset=ISO-2022-JP`,
			'',
			`--${boundary}`,
			'Content-Type: text/plain; charset=Shift_JIS',
			'',
			'plain healthy body',
			`--${boundary}`,
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>html healthy body</p>',
			`--${boundary}--`,
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.text).toContain('plain healthy body');
		expect(parsed.html).toContain('<p>html healthy body</p>');
		expect(parsed.textCharset).toBe('iso-2022-jp');
		expect(parsed.htmlCharset).toBe('iso-2022-jp');
	});

	it('keeps compatibility fallback for malformed multipart/alternative', async () => {
		const boundary = '----broken-alt';
		const raw = [
			'From: Sender <sender@example.com>',
			'To: Receiver <receiver@example.com>',
			'Subject: broken alternative',
			`Content-Type: multipart/alternative; boundary="${boundary}"; charset=ISO-2022-JP`,
			'',
			`--${boundary}`,
			'Content-Type: text/plain; charset=Shift_JIS',
			'',
			'plain broken body',
			`--${boundary}`,
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>html broken body</p>',
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.text).toContain('plain broken body');
		expect(parsed.html).toContain('<p>html broken body</p>');
		expect(parsed.textCharset).toBe('windows-31j');
		expect(parsed.htmlCharset).toBe('utf-8');
	});

	it('prefers postal output for simple multipart/mixed', async () => {
		const boundary = '----healthy-mixed';
		const raw = [
			'From: Sender <sender@example.com>',
			'To: Receiver <receiver@example.com>',
			'Subject: healthy mixed',
			`Content-Type: multipart/mixed; boundary="${boundary}"; charset=ISO-2022-JP`,
			'',
			`--${boundary}`,
			'Content-Type: text/plain; charset=Shift_JIS',
			'',
			'plain mixed body',
			`--${boundary}`,
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>html mixed body</p>',
			`--${boundary}`,
			'Content-Type: application/octet-stream',
			'Content-Disposition: attachment; filename="dummy.bin"',
			'',
			'ignored-binary-content',
			`--${boundary}--`,
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.text).toContain('plain mixed body');
		expect(parsed.html).toContain('<p>html mixed body</p>');
		expect(parsed.textCharset).toBe('iso-2022-jp');
		expect(parsed.htmlCharset).toBe('iso-2022-jp');
	});

	it('keeps compatibility fallback for malformed multipart/mixed', async () => {
		const boundary = '----broken-mixed';
		const raw = [
			'From: Sender <sender@example.com>',
			'To: Receiver <receiver@example.com>',
			'Subject: broken mixed',
			`Content-Type: multipart/mixed; boundary="${boundary}"; charset=ISO-2022-JP`,
			'',
			`--${boundary}`,
			'Content-Type: text/plain; charset=Shift_JIS',
			'',
			'plain broken mixed body',
			`--${boundary}`,
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>html broken mixed body</p>',
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.text).toContain('plain broken mixed body');
		expect(parsed.html).toContain('<p>html broken mixed body</p>');
		expect(parsed.textCharset).toBe('windows-31j');
		expect(parsed.htmlCharset).toBe('utf-8');
	});

	it('keeps text and html extraction for nested multipart mixed + alternative', async () => {
		const outerBoundary = '----outer-mixed';
		const innerBoundary = '----inner-alt';
		const raw = [
			'From: Sender <sender@example.com>',
			'To: Receiver <receiver@example.com>',
			'Subject: nested mixed alt',
			`Content-Type: multipart/mixed; boundary="${outerBoundary}"; charset=utf-8`,
			'',
			`--${outerBoundary}`,
			`Content-Type: multipart/alternative; boundary="${innerBoundary}"`,
			'',
			`--${innerBoundary}`,
			'Content-Type: text/plain; charset=utf-8',
			'',
			'plain nested body',
			`--${innerBoundary}`,
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>html nested body</p>',
			`--${innerBoundary}--`,
			`--${outerBoundary}`,
			'Content-Type: application/octet-stream',
			'Content-Disposition: attachment; filename="dummy.bin"',
			'',
			'ignored-binary-content',
			`--${outerBoundary}--`,
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.text).toContain('plain nested body');
		expect(parsed.html).toContain('<p>html nested body</p>');
		expect(parsed.textCharset).toBe('utf-8');
		expect(parsed.htmlCharset).toBe('utf-8');
	});
});
