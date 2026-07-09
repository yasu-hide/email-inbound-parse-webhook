import { describe, expect, it } from 'vitest';
import { inspectMultipartFallbackForRawInput, parseEmailStreamWithPostalMime } from '../src/email-parser/postal-mime-adapter';
import { parsedBodyBytesSymbol } from '../src/email-parser/types';

async function parseRaw(raw: string | Uint8Array) {
	const stream = new Response(raw).body;
	if (!stream) throw new Error('Failed to create stream');
	return parseEmailStreamWithPostalMime(stream);
}

function bytesFrom(...parts: Array<string | number[]>): Uint8Array {
	const encoder = new TextEncoder();
	const chunks = parts.map((part) => (typeof part === 'string' ? encoder.encode(part) : Uint8Array.from(part)));
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

// Shift_JIS bytes for 日本語
const SJIS_NIHONGO = [0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea];
// EUC-JP bytes for 日本語 (all bytes >= 0xa0 so they survive the latin1 round-trip in the compat path)
const EUCJP_NIHONGO = [0xc6, 0xfc, 0xcb, 0xdc, 0xb8, 0xec];

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
		expect(parsed.textCharset).toBe('windows-31j');
		expect(parsed.htmlCharset).toBe('utf-8');
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
		expect(parsed.textCharset).toBe('windows-31j');
		expect(parsed.htmlCharset).toBe('utf-8');
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

describe('postal-mime adapter address formatting', () => {
	it('keeps bare addresses without display names', async () => {
		const raw = [
			'From: sender@example.com',
			'To: receiver@example.com',
			'Subject: bare address',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'hello',
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.from).toBe('sender@example.com');
		expect(parsed.to).toBe('receiver@example.com');
	});

	it('expands group addresses into member mailboxes', async () => {
		const raw = [
			'From: Sender <sender@example.com>',
			'To: Team: a@example.com, Bob <b@example.com>;',
			'Subject: group address',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'hello',
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.to).toBe('a@example.com, Bob <b@example.com>');
	});

	it('omits recipients for an empty group address', async () => {
		const raw = [
			'From: Sender <sender@example.com>',
			'To: undisclosed-recipients:;',
			'Subject: empty group',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'hello',
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.to).toBeUndefined();
	});

	it('keeps a display name without an address', async () => {
		const raw = [
			'From: Sender <sender@example.com>',
			'To: Name Only',
			'Subject: name only',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'hello',
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.to).toBe('Name Only');
	});

	it('omits recipients for an empty angle-bracket address', async () => {
		const raw = [
			'From: Sender <sender@example.com>',
			'To: <>',
			'Subject: empty angle bracket',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'hello',
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.to).toBeUndefined();
	});

	it('formats group members that lack an address by their name', async () => {
		const raw = [
			'From: Sender <sender@example.com>',
			'To: Team: Member Name;',
			'Subject: name-only group member',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'hello',
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.to).toBe('Member Name');
	});

	it('joins duplicate headers with a comma', async () => {
		const raw = [
			'From: Sender <sender@example.com>',
			'Subject: duplicate headers',
			'X-Note: first',
			'X-Note: second',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'hello',
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.headers['x-note']).toBe('first, second');
	});
});

describe('postal-mime adapter single-part bodies', () => {
	it('strips a single trailing newline from text body and body bytes', async () => {
		const raw = [
			'From: Sender <sender@example.com>',
			'Subject: trailing newline',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'plain body text',
			'',
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.text).toBe('plain body text');
		const bodyBytes = parsed[parsedBodyBytesSymbol]?.text;
		expect(bodyBytes).toBeDefined();
		expect(new TextDecoder().decode(bodyBytes)).toBe('plain body text');
	});

	it('maps html-only email to html fields', async () => {
		const raw = [
			'From: Sender <sender@example.com>',
			'Subject: html only',
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>html only body</p>',
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.html).toBe('<p>html only body</p>');
		expect(parsed.htmlCharset).toBe('utf-8');
		expect(parsed.text).toBeUndefined();
		const bodyBytes = parsed[parsedBodyBytesSymbol]?.html;
		expect(bodyBytes).toBeDefined();
		expect(new TextDecoder().decode(bodyBytes)).toBe('<p>html only body</p>');
	});

	it('decodes base64 single-part body into text and body bytes', async () => {
		const raw = [
			'From: Sender <sender@example.com>',
			'Subject: base64 body',
			'Content-Type: text/plain; charset=utf-8',
			'Content-Transfer-Encoding: base64',
			'',
			btoa('base64 body text'),
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.text).toBe('base64 body text');
		const bodyBytes = parsed[parsedBodyBytesSymbol]?.text;
		expect(new TextDecoder().decode(bodyBytes)).toBe('base64 body text');
	});

	it('recovers mislabeled single-part body from raw bytes', async () => {
		const raw = bytesFrom(
			[
				'From: Sender <sender@example.com>',
				'Subject: mislabeled charset',
				'Content-Type: text/plain; charset=utf-8',
				'',
				'',
			].join('\r\n'),
			SJIS_NIHONGO,
		);

		const parsed = await parseRaw(raw);
		expect(parsed.text).toBe('日本語');
		expect(parsed.text).not.toContain('�');
		expect(parsed.textCharset).toBe('windows-31j');
	});

	it('parses emails with LF-only line endings', async () => {
		const raw = [
			'From: Sender <sender@example.com>',
			'Subject: lf only',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'lf body',
		].join('\n');

		const parsed = await parseRaw(raw);
		expect(parsed.subject).toBe('lf only');
		expect(parsed.text).toBe('lf body');
	});

	it('handles input without a header/body separator gracefully', async () => {
		const raw = 'plain text without any header lines';

		const parsed = await parseRaw(raw);
		expect(parsed.subject).toBeUndefined();
		expect(parsed.text).toBeUndefined();
		// コロンを含む行が無いため rawHeaders は空になり、postal-mime のヘッダにフォールバックする
		expect(parsed.headers).toEqual({ 'plain text without any header lines': '' });
		expect(parsed.rawHeaders).toEqual(parsed.headers);
	});
});

describe('postal-mime adapter multipart compat details', () => {
	it('joins multiple text parts with a newline in compat fallback', async () => {
		const boundary = '----multi-text';
		const raw = [
			'From: Sender <sender@example.com>',
			'Subject: multiple text parts',
			`Content-Type: multipart/alternative; boundary="${boundary}"`,
			'',
			`--${boundary}`,
			'Content-Type: text/plain; charset=utf-8',
			'',
			'first part',
			`--${boundary}`,
			'Content-Type: text/plain; charset=utf-8',
			'',
			'second part',
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.text).toBe('first part\nsecond part');
		const bodyBytes = parsed[parsedBodyBytesSymbol]?.text;
		expect(new TextDecoder().decode(bodyBytes)).toBe('first part\nsecond part');
	});

	it('returns no body when alternative parts are neither text nor html', async () => {
		const boundary = '----binary-alt';
		const raw = [
			'From: Sender <sender@example.com>',
			'Subject: binary alternative',
			`Content-Type: multipart/alternative; boundary="${boundary}"`,
			'',
			`--${boundary}`,
			'Content-Type: application/octet-stream',
			'Content-Disposition: attachment; filename="data.bin"',
			'',
			'binarydata',
			`--${boundary}--`,
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.text).toBeUndefined();
		expect(parsed.html).toBeUndefined();
	});

	it('extracts bodies from multipart/related via compat fallback', async () => {
		const boundary = '----related';
		const raw = [
			'From: Sender <sender@example.com>',
			'Subject: related multipart',
			`Content-Type: multipart/related; boundary="${boundary}"; charset=utf-8`,
			'',
			`--${boundary}`,
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>related html body</p>',
			`--${boundary}--`,
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.html).toContain('<p>related html body</p>');
		expect(parsed.htmlCharset).toBe('utf-8');
	});

	it('falls back for mixed containing a nested non-alternative multipart', async () => {
		const outerBoundary = '----outer-complex';
		const innerBoundary = '----inner-related';
		const raw = [
			'From: Sender <sender@example.com>',
			'Subject: complex mixed',
			`Content-Type: multipart/mixed; boundary="${outerBoundary}"`,
			'',
			`--${outerBoundary}`,
			`Content-Type: multipart/related; boundary="${innerBoundary}"`,
			'',
			`--${innerBoundary}`,
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>inner related html</p>',
			`--${innerBoundary}--`,
			`--${outerBoundary}`,
			'Content-Type: text/plain; charset=utf-8',
			'',
			'plain complex text',
			`--${outerBoundary}--`,
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.text).toContain('plain complex text');
	});

	it('joins multiple html parts with a newline in compat fallback', async () => {
		const boundary = '----multi-html';
		const raw = [
			'From: Sender <sender@example.com>',
			'Subject: multiple html parts',
			`Content-Type: multipart/alternative; boundary="${boundary}"`,
			'',
			`--${boundary}`,
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>first html</p>',
			`--${boundary}`,
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>second html</p>',
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.html).toBe('<p>first html</p>\n<p>second html</p>');
	});

	it('returns no body when the multipart boundary parameter is missing', async () => {
		const raw = [
			'From: Sender <sender@example.com>',
			'Subject: no boundary',
			'Content-Type: multipart/alternative',
			'',
			'body without boundary',
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.text).toBeUndefined();
		expect(parsed.html).toBeUndefined();
	});

	it('treats parts without Content-Type as text/plain', async () => {
		const boundary = '----headerless-part';
		const raw = [
			'From: Sender <sender@example.com>',
			'Subject: headerless part',
			`Content-Type: multipart/mixed; boundary="${boundary}"`,
			'',
			`--${boundary}`,
			'',
			'no header part body',
			`--${boundary}--`,
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.text).toContain('no header part body');
		expect(parsed.textCharset).toBe('utf-8');
	});

	it('tolerates duplicate part headers in compat fallback', async () => {
		const boundary = '----dup-part-headers';
		const raw = [
			'From: Sender <sender@example.com>',
			'Subject: duplicate part headers',
			`Content-Type: multipart/alternative; boundary="${boundary}"`,
			'',
			`--${boundary}`,
			'Content-Type: text/plain; charset=utf-8',
			'X-Note: first',
			'X-Note: second',
			'',
			'dup header part body',
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.text).toBe('dup header part body');
	});

	it('keeps text-only healthy multipart/alternative without html', async () => {
		const boundary = '----text-only-alt';
		const raw = [
			'From: Sender <sender@example.com>',
			'Subject: text only alternative',
			`Content-Type: multipart/alternative; boundary="${boundary}"`,
			'',
			`--${boundary}`,
			'Content-Type: text/plain; charset=utf-8',
			'',
			'text only body',
			`--${boundary}--`,
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.text).toBe('text only body');
		expect(parsed.html).toBeUndefined();
	});

	it('keeps html-only healthy multipart/alternative without text', async () => {
		const boundary = '----html-only-alt';
		const raw = [
			'From: Sender <sender@example.com>',
			'Subject: html only alternative',
			`Content-Type: multipart/alternative; boundary="${boundary}"`,
			'',
			`--${boundary}`,
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>html only alt body</p>',
			`--${boundary}--`,
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.html).toBe('<p>html only alt body</p>');
		expect(parsed.text).toBeUndefined();
	});

	it('recovers mislabeled multipart text part from raw bytes', async () => {
		const boundary = '----mojibake-alt';
		const raw = bytesFrom(
			[
				'From: Sender <sender@example.com>',
				'Subject: mojibake alternative',
				`Content-Type: multipart/alternative; boundary="${boundary}"`,
				'',
				`--${boundary}`,
				'Content-Type: text/plain; charset=utf-8',
				'',
				'',
			].join('\r\n'),
			EUCJP_NIHONGO,
			`\r\n--${boundary}--`,
		);

		const parsed = await parseRaw(raw);
		expect(parsed.text).toBe('日本語');
		expect(parsed.text).not.toContain('�');
		expect(parsed.textCharset).toBe('euc-jp');
	});

	it('recovers mislabeled multipart/alternative text part from Shift_JIS raw bytes', async () => {
		const boundary = '----mojibake-sjis-alt';
		const raw = bytesFrom(
			[
				'From: Sender <sender@example.com>',
				'Subject: mojibake sjis alternative',
				`Content-Type: multipart/alternative; boundary="${boundary}"`,
				'',
				`--${boundary}`,
				'Content-Type: text/plain; charset=utf-8',
				'',
				'',
			].join('\r\n'),
			SJIS_NIHONGO,
			`\r\n--${boundary}--`,
		);

		const parsed = await parseRaw(raw);
		expect(parsed.text).toBe('日本語');
		expect(parsed.text).not.toContain('�');
		expect(parsed.textCharset).toBe('windows-31j');
		expect(Array.from(parsed[parsedBodyBytesSymbol]?.text ?? [])).toEqual(SJIS_NIHONGO);
	});

	it('recovers mislabeled multipart/mixed text part from Shift_JIS raw bytes', async () => {
		const boundary = '----mojibake-sjis-mixed';
		const raw = bytesFrom(
			[
				'From: Sender <sender@example.com>',
				'Subject: mojibake sjis mixed',
				`Content-Type: multipart/mixed; boundary="${boundary}"`,
				'',
				`--${boundary}`,
				'Content-Type: text/plain; charset=utf-8',
				'',
				'',
			].join('\r\n'),
			SJIS_NIHONGO,
			`\r\n--${boundary}--`,
		);

		const parsed = await parseRaw(raw);
		expect(parsed.text).toBe('日本語');
		expect(parsed.text).not.toContain('�');
		expect(parsed.textCharset).toBe('windows-31j');
		expect(Array.from(parsed[parsedBodyBytesSymbol]?.text ?? [])).toEqual(SJIS_NIHONGO);
	});

	it('strips a single leading CRLF from part content in compat fallback', async () => {
		const boundary = '----leading-crlf';
		const raw = [
			'From: Sender <sender@example.com>',
			'Subject: leading crlf',
			`Content-Type: multipart/alternative; boundary="${boundary}"`,
			'',
			`--${boundary}`,
			'Content-Type: text/plain; charset=utf-8',
			'',
			'',
			'padded body',
		].join('\r\n');

		const parsed = await parseRaw(raw);
		expect(parsed.text).toBe('padded body');
	});

	it('strips a single leading LF from part content in LF-only compat fallback', async () => {
		const boundary = '----leading-lf';
		const raw = [
			'From: Sender <sender@example.com>',
			'Subject: leading lf',
			`Content-Type: multipart/alternative; boundary="${boundary}"`,
			'',
			`--${boundary}`,
			'Content-Type: text/plain; charset=utf-8',
			'',
			'',
			'lf padded body',
		].join('\n');

		const parsed = await parseRaw(raw);
		expect(parsed.text).toBe('lf padded body');
	});
});

describe('inspectMultipartFallbackForRawInput', () => {
	it('reports non-multipart email as not needing fallback', async () => {
		const raw = ['From: Sender <sender@example.com>', 'Content-Type: text/plain; charset=utf-8', '', 'hello'].join('\r\n');

		const inspection = await inspectMultipartFallbackForRawInput(raw);
		expect(inspection.isMultipart).toBe(false);
		expect(inspection.shouldFallback).toBe(false);
		expect(inspection.contentType).toBe('text/plain; charset=utf-8');
	});

	it('omits contentType when the header is missing', async () => {
		const raw = ['From: Sender <sender@example.com>', 'Subject: no content type', '', 'hello'].join('\r\n');

		const inspection = await inspectMultipartFallbackForRawInput(raw);
		expect(inspection.isMultipart).toBe(false);
		expect(inspection.contentType).toBeUndefined();
	});

	it('accepts Uint8Array input', async () => {
		const raw = new TextEncoder().encode(
			['From: Sender <sender@example.com>', 'Content-Type: text/plain; charset=utf-8', '', 'hello'].join('\r\n'),
		);

		const inspection = await inspectMultipartFallbackForRawInput(raw);
		expect(inspection.isMultipart).toBe(false);
		expect(inspection.shouldFallback).toBe(false);
	});

	it('does not fall back for a healthy multipart/alternative', async () => {
		const boundary = '----inspect-healthy';
		const raw = [
			'From: Sender <sender@example.com>',
			`Content-Type: multipart/alternative; boundary="${boundary}"`,
			'',
			`--${boundary}`,
			'Content-Type: text/plain; charset=utf-8',
			'',
			'plain body',
			`--${boundary}--`,
		].join('\r\n');

		const inspection = await inspectMultipartFallbackForRawInput(raw);
		expect(inspection.isMultipart).toBe(true);
		expect(inspection.shouldFallback).toBe(false);
		expect(inspection.reason).toBeUndefined();
	});

	it('reports missing_boundary when boundary parameter is absent', async () => {
		const raw = ['From: Sender <sender@example.com>', 'Content-Type: multipart/alternative', '', 'body without boundary'].join('\r\n');

		const inspection = await inspectMultipartFallbackForRawInput(raw);
		expect(inspection.shouldFallback).toBe(true);
		expect(inspection.reason).toBe('missing_boundary');
	});

	it('reports missing_opening_boundary when body lacks the boundary marker', async () => {
		const raw = [
			'From: Sender <sender@example.com>',
			'Content-Type: multipart/alternative; boundary="----inspect-absent"',
			'',
			'body without any boundary marker',
		].join('\r\n');

		const inspection = await inspectMultipartFallbackForRawInput(raw);
		expect(inspection.shouldFallback).toBe(true);
		expect(inspection.reason).toBe('missing_opening_boundary');
	});

	it('reports missing_closing_boundary when terminator is absent', async () => {
		const boundary = '----inspect-unclosed';
		const raw = [
			'From: Sender <sender@example.com>',
			`Content-Type: multipart/alternative; boundary="${boundary}"`,
			'',
			`--${boundary}`,
			'Content-Type: text/plain; charset=utf-8',
			'',
			'plain body',
		].join('\r\n');

		const inspection = await inspectMultipartFallbackForRawInput(raw);
		expect(inspection.shouldFallback).toBe(true);
		expect(inspection.reason).toBe('missing_closing_boundary');
	});

	it('reports non_alternative_multipart for multipart/related', async () => {
		const boundary = '----inspect-related';
		const raw = [
			'From: Sender <sender@example.com>',
			`Content-Type: multipart/related; boundary="${boundary}"`,
			'',
			`--${boundary}`,
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>related</p>',
			`--${boundary}--`,
		].join('\r\n');

		const inspection = await inspectMultipartFallbackForRawInput(raw);
		expect(inspection.shouldFallback).toBe(true);
		expect(inspection.reason).toBe('non_alternative_multipart');
	});

	it('reports complex_mixed_structure for nested non-alternative multipart', async () => {
		const outerBoundary = '----inspect-outer';
		const innerBoundary = '----inspect-inner';
		const raw = [
			'From: Sender <sender@example.com>',
			`Content-Type: multipart/mixed; boundary="${outerBoundary}"`,
			'',
			`--${outerBoundary}`,
			`Content-Type: multipart/related; boundary="${innerBoundary}"`,
			'',
			`--${innerBoundary}`,
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>inner</p>',
			`--${innerBoundary}--`,
			`--${outerBoundary}--`,
		].join('\r\n');

		const inspection = await inspectMultipartFallbackForRawInput(raw);
		expect(inspection.shouldFallback).toBe(true);
		expect(inspection.reason).toBe('complex_mixed_structure');
	});

	it('reports part_header_separator_missing when a part has no blank line', async () => {
		const boundary = '----inspect-no-sep';
		const raw = [
			'From: Sender <sender@example.com>',
			`Content-Type: multipart/mixed; boundary="${boundary}"`,
			'',
			`--${boundary}`,
			'Content-Type: text/plain; charset=utf-8',
			`--${boundary}--`,
		].join('\r\n');

		const inspection = await inspectMultipartFallbackForRawInput(raw);
		expect(inspection.shouldFallback).toBe(true);
		expect(inspection.reason).toBe('part_header_separator_missing');
	});

	it('reports part_delimiter_misaligned when boundary is glued to content', async () => {
		const boundary = '----inspect-glued';
		const raw = [
			'From: Sender <sender@example.com>',
			`Content-Type: multipart/mixed; boundary="${boundary}"`,
			'',
			`--${boundary}`,
			'Content-Type: text/plain; charset=utf-8',
			'',
			`glued content--${boundary}--`,
		].join('\r\n');

		const inspection = await inspectMultipartFallbackForRawInput(raw);
		expect(inspection.shouldFallback).toBe(true);
		expect(inspection.reason).toBe('part_delimiter_misaligned');
	});

	it('reports missing_text_and_html when no displayable part exists', async () => {
		const boundary = '----inspect-binary';
		const raw = [
			'From: Sender <sender@example.com>',
			`Content-Type: multipart/alternative; boundary="${boundary}"`,
			'',
			`--${boundary}`,
			'Content-Type: application/octet-stream',
			'Content-Disposition: attachment; filename="data.bin"',
			'',
			'binarydata',
			`--${boundary}--`,
		].join('\r\n');

		const inspection = await inspectMultipartFallbackForRawInput(raw);
		expect(inspection.shouldFallback).toBe(true);
		expect(inspection.reason).toBe('missing_text_and_html');
	});

	it('reports missing_text_and_html for mixed with only attachments', async () => {
		const boundary = '----inspect-mixed-attach';
		const raw = [
			'From: Sender <sender@example.com>',
			`Content-Type: multipart/mixed; boundary="${boundary}"`,
			'',
			`--${boundary}`,
			'Content-Type: application/octet-stream',
			'Content-Disposition: attachment; filename="data.bin"',
			'',
			'binarydata',
			`--${boundary}--`,
		].join('\r\n');

		const inspection = await inspectMultipartFallbackForRawInput(raw);
		expect(inspection.shouldFallback).toBe(true);
		expect(inspection.reason).toBe('missing_text_and_html');
	});

	it('reports replacement_character_detected for mislabeled mixed part bytes', async () => {
		const boundary = '----inspect-mixed-mojibake';
		const raw = bytesFrom(
			[
				'From: Sender <sender@example.com>',
				`Content-Type: multipart/mixed; boundary="${boundary}"`,
				'',
				`--${boundary}`,
				'Content-Type: text/plain; charset=utf-8',
				'',
				'',
			].join('\r\n'),
			SJIS_NIHONGO,
			`\r\n--${boundary}--`,
		);

		const inspection = await inspectMultipartFallbackForRawInput(raw);
		expect(inspection.shouldFallback).toBe(true);
		expect(inspection.reason).toBe('replacement_character_detected');
	});

	it('reports replacement_character_detected for mislabeled part bytes', async () => {
		const boundary = '----inspect-mojibake';
		const raw = bytesFrom(
			[
				'From: Sender <sender@example.com>',
				`Content-Type: multipart/alternative; boundary="${boundary}"`,
				'',
				`--${boundary}`,
				'Content-Type: text/plain; charset=utf-8',
				'',
				'',
			].join('\r\n'),
			SJIS_NIHONGO,
			`\r\n--${boundary}--`,
		);

		const inspection = await inspectMultipartFallbackForRawInput(raw);
		expect(inspection.shouldFallback).toBe(true);
		expect(inspection.reason).toBe('replacement_character_detected');
	});
});
