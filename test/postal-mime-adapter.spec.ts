import PostalMime from 'postal-mime';
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
		// 先頭行がヘッダーでも折り返しでもないため、postal-mime 4.1.4 と同様に入力全体が本文になる
		expect(parsed.text).toBe(raw);
		expect(new TextDecoder().decode(parsed[parsedBodyBytesSymbol]?.text)).toBe(raw);
		expect(parsed.headers).toEqual({});
		expect(parsed.rawHeaders).toEqual({});
	});
});

// アダプタの送信バイトは CRLF のまま、postal-mime の text は LF 正規化済みで末尾に改行が付くため揃えて比べる
function normalizeBodyForCompare(value: string): string {
	return value.replace(/\r\n/g, '\n').replace(/\n$/, '');
}

describe('postal-mime adapter top-level header block', () => {
	// 非マルチパートの入力で、ヘッダー/本文の分割が postal-mime 単体の結果と一致すること
	const differentialCorpus: Array<[string, string | Uint8Array]> = [
		['plain text', ['Subject: s', 'Content-Type: text/plain; charset=utf-8', '', 'hello', 'world'].join('\r\n')],
		['html only', ['Subject: s', 'Content-Type: text/html; charset=utf-8', '', '<p>x</p>'].join('\r\n')],
		['base64 text', ['Subject: s', 'Content-Transfer-Encoding: base64', '', btoa('base64 text')].join('\r\n')],
		['empty line with extra CR', 'Subject: x\r\n\r\r\nbody'],
		['whitespace-only line then junk', 'Subject: a\r\n \r\njunk\r\n\r\nbody'],
		['NBSP-prefixed Content-Type', 'Subject: s\r\n Content-Type: text/html\r\n\r\n<p>x</p>'],
		['NBSP-prefixed Content-Transfer-Encoding', 'Subject: s\r\n Content-Transfer-Encoding: base64\r\n\r\naGVsbG8='],
		['BOM-prefixed Content-Type', 'Subject: s\r\n﻿Content-Type: text/html\r\n\r\n<p>x</p>'],
		['leading mbox From line', 'From sender@example.com Mon Jan  1 00:00:00 2024\r\nSubject: s\r\n\r\nbody'],
		['From line carrying Content-Type', 'Subject: s\r\nFrom Content-Type: text/html\r\n\r\n<p>x</p>'],
		['empty-name field carrying Content-Type', 'Subject: s\r\n: Content-Type: text/html\r\n\r\n<p>x</p>'],
		['empty-name field before Content-Type', 'Subject: s\r\n: x\r\nContent-Type: text/html\r\n\r\n<p>x</p>'],
		['LF only', 'Subject: s\nContent-Type: text/plain\n\nbody\n\nmore'],
		['LF headers with CRLF separator', 'Subject: s\nX-A: y\r\n\r\nbody'],
		['LF separator with CRLF blank line in body', 'Subject: s\n\nbody line\r\n\r\nmore'],
		['escaped From line', 'Subject: s\r\n&gt;From x\r\nContent-Type: text/html\r\n\r\n<p>x</p>'],
		['no header lines', 'plain text without any header lines'],
		[
			'malformed folded header',
			[
				'From: Sender <sender@example.com>',
				'Subject: valid prefix',
				'broken continuation without colon',
				'Content-Type: text/plain; charset=utf-8',
				'',
				'hello',
			].join('\r\n'),
		],
		// 重複したヘッダーと CTE の書式(Issue #49 項目 2): 最初の出現と、コメント除去後の先頭トークンを採用する
		['duplicate Content-Transfer-Encoding', ['Subject: s', 'Content-Transfer-Encoding: base64', 'Content-Transfer-Encoding: base64', '', btoa('dup cte')].join('\r\n')],
		['first Content-Transfer-Encoding wins', ['Subject: s', 'Content-Transfer-Encoding: base64', 'Content-Transfer-Encoding: 7bit', '', btoa('first cte')].join('\r\n')],
		['duplicate Content-Type', ['Subject: s', 'Content-Type: text/plain; charset=utf-8', 'Content-Type: text/html; charset=utf-8', '', '<p>x</p>'].join('\r\n')],
		['CTE with a leading comment', ['Subject: s', 'Content-Transfer-Encoding: (c) base64', '', btoa('comment before')].join('\r\n')],
		['CTE with a trailing comment', ['Subject: s', 'Content-Transfer-Encoding: base64 (c)', '', btoa('comment after')].join('\r\n')],
		['quoted CTE', ['Subject: s', 'Content-Transfer-Encoding: "base64"', '', btoa('quoted cte')].join('\r\n')],
		['CTE with a leading token', ['Subject: s', 'Content-Transfer-Encoding: x base64', '', btoa('leading token')].join('\r\n')],
		['mixed-case CTE with trailing whitespace', ['Subject: s', 'Content-Transfer-Encoding: Base64 ', '', btoa('mixed case')].join('\r\n')],
		// コメントの入れ子・エスケープ・途中のコメントなど、postal-mime の stripComments と同じ除去結果になる形
		['CTE with a nested comment', ['Subject: s', 'Content-Transfer-Encoding: ((c)) base64', '', btoa('nested comment')].join('\r\n')],
		['CTE with a comment containing a nested comment', ['Subject: s', 'Content-Transfer-Encoding: (a (b) c) base64', '', btoa('inner comment')].join('\r\n')],
		['CTE with an escaped parenthesis in a comment', ['Subject: s', 'Content-Transfer-Encoding: (a\\) b) base64', '', btoa('escaped paren')].join('\r\n')],
		['CTE with consecutive comments', ['Subject: s', 'Content-Transfer-Encoding: (c)(d) base64', '', btoa('two comments')].join('\r\n')],
		['CTE with a comment inside the token', ['Subject: s', 'Content-Transfer-Encoding: base(c)64', '', btoa('mid token')].join('\r\n')],
		['CTE with an unterminated comment', ['Subject: s', 'Content-Transfer-Encoding: (unterminated base64', '', btoa('unterminated')].join('\r\n')],
		['CTE with a quoted string inside a comment', ['Subject: s', 'Content-Transfer-Encoding: (a "x) y" z) base64', '', btoa('quote in comment')].join('\r\n')],
	];

	it.each(differentialCorpus)('matches postal-mime text and body bytes: %s', async (_name, raw) => {
		const expected = await PostalMime.parse(raw);
		const parsed = await parseRaw(raw);
		for (const field of ['text', 'html'] as const) {
			const expectedValue = expected[field];
			if (expectedValue === undefined) {
				expect(parsed[field]).toBeUndefined();
				expect(parsed[parsedBodyBytesSymbol]?.[field]).toBeUndefined();
				continue;
			}
			expect(normalizeBodyForCompare(parsed[field] ?? '')).toBe(normalizeBodyForCompare(expectedValue));
			const bodyBytes = parsed[parsedBodyBytesSymbol]?.[field];
			expect(bodyBytes).toBeDefined();
			expect(normalizeBodyForCompare(new TextDecoder().decode(bodyBytes))).toBe(normalizeBodyForCompare(expectedValue));
		}
	});

	it('treats a line of only CR before LF as the empty line', async () => {
		const parsed = await parseRaw('Subject: x\r\n\r\r\nbody');
		expect(parsed.headers).toEqual({ subject: 'x' });
		expect(parsed.text).toBe('body');
		expect(new TextDecoder().decode(parsed[parsedBodyBytesSymbol]?.text)).toBe('body');
	});

	it('starts the body at the junk line after a whitespace-only line', async () => {
		const parsed = await parseRaw('Subject: a\r\n \r\njunk\r\n\r\nbody');
		expect(parsed.subject).toBe('a');
		expect(parsed.text).toBe('junk\n\nbody');
		expect(new TextDecoder().decode(parsed[parsedBodyBytesSymbol]?.text)).toBe('junk\r\n\r\nbody');
	});

	it.each([
		['NBSP-prefixed (UTF-8)', bytesFrom('Subject: s\r\n', [0xc2, 0xa0], 'Content-Type: text/html\r\n\r\n<p>x</p>')],
		['NBSP-prefixed (latin1)', bytesFrom('Subject: s\r\n', [0xa0], 'Content-Type: text/html\r\n\r\n<p>x</p>')],
		['BOM-prefixed', bytesFrom('Subject: s\r\n', [0xef, 0xbb, 0xbf], 'Content-Type: text/html\r\n\r\n<p>x</p>')],
		['mbox From line', 'Subject: s\r\nFrom Content-Type: text/html\r\n\r\n<p>x</p>'],
		['empty-name field', 'Subject: s\r\n: Content-Type: text/html\r\n\r\n<p>x</p>'],
		['escaped From line', 'Subject: s\r\n&gt;From x\r\nContent-Type: text/html\r\n\r\n<p>x</p>'],
	])('does not adopt a smuggled Content-Type: %s', async (_name, raw) => {
		const parsed = await parseRaw(raw);
		expect(parsed.headers['content-type']).toBeUndefined();
		expect(parsed.rawHeaders?.['content-type']).toBeUndefined();
		expect(parsed.html).toBeUndefined();
		expect(parsed.text).toContain('<p>x</p>');
	});

	it('does not adopt a smuggled Content-Transfer-Encoding', async () => {
		const parsed = await parseRaw('Subject: s\r\n Content-Transfer-Encoding: base64\r\n\r\naGVsbG8=');
		expect(parsed.rawHeaders?.['content-transfer-encoding']).toBeUndefined();
		expect(parsed.text).toBe(' Content-Transfer-Encoding: base64\n\naGVsbG8=');
		expect(new TextDecoder().decode(parsed[parsedBodyBytesSymbol]?.text)).toBe(' Content-Transfer-Encoding: base64\r\n\r\naGVsbG8=');
	});

	it('keeps an mbox From line and an empty-name field inside the header block', async () => {
		const parsed = await parseRaw('From sender@example.com Mon Jan  1 00:00:00 2024\r\nSubject: s\r\n: x\r\nContent-Type: text/html\r\n\r\n<p>x</p>');
		expect(parsed.subject).toBe('s');
		expect(parsed.rawHeaders?.['content-type']).toBe('text/html');
		expect(parsed.html).toBe('<p>x</p>');
		expect(parsed.text).toBeUndefined();
	});

	it('ends the header block at an escaped From line', async () => {
		const parsed = await parseRaw('Subject: s\r\n&gt;From x\r\nContent-Type: text/html\r\n\r\n<p>x</p>');
		expect(parsed.rawHeaders).toEqual({ subject: 's' });
		expect(parsed.text).toBe('&gt;From x\nContent-Type: text/html\n\n<p>x</p>');
	});

	it('splits LF-only and CRLF/LF mixed input at the first empty line', async () => {
		const lfOnly = await parseRaw('Subject: s\nContent-Type: text/plain\n\nbody\n\nmore');
		expect(lfOnly.rawHeaders?.['content-type']).toBe('text/plain');
		expect(new TextDecoder().decode(lfOnly[parsedBodyBytesSymbol]?.text)).toBe('body\n\nmore');

		const crlfSeparator = await parseRaw('Subject: s\nX-A: y\r\n\r\nbody');
		expect(crlfSeparator.rawHeaders).toEqual({ subject: 's', 'x-a': 'y' });
		expect(new TextDecoder().decode(crlfSeparator[parsedBodyBytesSymbol]?.text)).toBe('body');

		// 本文中の CRLFCRLF をヘッダー終端と誤認しないこと
		const crlfInBody = await parseRaw('Subject: s\n\nbody line\r\n\r\nmore');
		expect(crlfInBody.rawHeaders).toEqual({ subject: 's' });
		expect(crlfInBody.text).toBe('body line\n\nmore');
		expect(new TextDecoder().decode(crlfInBody[parsedBodyBytesSymbol]?.text)).toBe('body line\r\n\r\nmore');
	});

	it('decodes a duplicated Content-Transfer-Encoding while keeping the joined header map', async () => {
		const parsed = await parseRaw(['Subject: s', 'Content-Transfer-Encoding: base64', 'Content-Transfer-Encoding: base64', '', btoa('dup cte')].join('\r\n'));
		expect(parsed.text).toBe('dup cte');
		expect(new TextDecoder().decode(parsed[parsedBodyBytesSymbol]?.text)).toBe('dup cte');
		// rawHeaders / headers の結合マップの契約は変えない
		expect(parsed.rawHeaders?.['content-transfer-encoding']).toBe('base64, base64');
		expect(parsed.headers['content-transfer-encoding']).toBe('base64, base64');
	});
});

describe('postal-mime adapter part header junk lines', () => {
	// パートヘッダーに junk 行(フィールドでも折り返しでもない行)がある健全なマルチパート(Issue #49 項目 1)。
	// postal-mime 4.1.4 は junk 行でパートヘッダーを終えるが、compat は空行まで読むため、compat フォールバックへ送り
	// text と送信バイトをともに compat 由来に揃える
	function junkPartRaw(subtype: 'alternative' | 'mixed', newline: string): string {
		return [
			'From: Sender <sender@example.com>',
			`Content-Type: multipart/${subtype}; boundary="b"`,
			'',
			'--b',
			'Content-Type: text/plain; charset=utf-8',
			'broken line',
			'',
			'plain body',
			'--b',
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>html</p>',
			'--b--',
		].join(newline);
	}

	it.each([
		['alternative', 'CRLF', junkPartRaw('alternative', '\r\n')],
		['mixed', 'CRLF', junkPartRaw('mixed', '\r\n')],
		['alternative', 'LF', junkPartRaw('alternative', '\n')],
		['mixed', 'LF', junkPartRaw('mixed', '\n')],
	])('falls back with part_header_malformed for multipart/%s (%s)', async (_subtype, _newline, raw) => {
		const inspection = await inspectMultipartFallbackForRawInput(raw);
		expect(inspection.shouldFallback).toBe(true);
		expect(inspection.reason).toBe('part_header_malformed');

		const parsed = await parseRaw(raw);
		// compat はパートヘッダーを空行まで読むため、junk 行は本文に含まれない(4.1.3 以前と同じ出力)
		expect(parsed.text).toBe('plain body');
		expect(parsed.html).toBe('<p>html</p>');
		expect(new TextDecoder().decode(parsed[parsedBodyBytesSymbol]?.text)).toBe(parsed.text);
		expect(new TextDecoder().decode(parsed[parsedBodyBytesSymbol]?.html)).toBe(parsed.html);
	});

	it.each([
		[
			'alternative text+html with a folded part header (N14)',
			[
				'From: Sender <sender@example.com>',
				'Content-Type: multipart/alternative; boundary="----n14"',
				'',
				'------n14',
				'Content-Type: text/plain;',
				'\tcharset=utf-8',
				'',
				'plain n14',
				'------n14',
				'Content-Type: text/html; charset=utf-8',
				'',
				'<p>html n14</p>',
				'------n14--',
			].join('\r\n'),
		],
		[
			'nested mixed + alternative (N23)',
			[
				'From: Sender <sender@example.com>',
				'Content-Type: multipart/mixed; boundary="----outer"',
				'',
				'------outer',
				'Content-Type: multipart/alternative; boundary="----inner"',
				'',
				'------inner',
				'Content-Type: text/plain; charset=utf-8',
				'',
				'plain nested',
				'------inner',
				'Content-Type: text/html; charset=utf-8',
				'',
				'<p>html nested</p>',
				'------inner--',
				'------outer--',
			].join('\r\n'),
		],
	])('does not fall back without a junk part header line: %s', async (_name, raw) => {
		const inspection = await inspectMultipartFallbackForRawInput(raw);
		expect(inspection.shouldFallback).toBe(false);
		expect(inspection.reason).toBeUndefined();
	});

	it('keeps complex_mixed_structure for a message/rfc822 part (N24)', async () => {
		// N24 の形は従来どおり complex_mixed_structure でフォールバックする(rfc822 本文中のヘッダー行は検査しない)
		const raw = [
			'From: Sender <sender@example.com>',
			'Content-Type: multipart/mixed; boundary="----n24"',
			'',
			'------n24',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'outer text',
			'------n24',
			'Content-Type: message/rfc822',
			'',
			'From: nested@example.com',
			'Subject: nested message',
			'',
			'nested body',
			'------n24--',
		].join('\r\n');

		const inspection = await inspectMultipartFallbackForRawInput(raw);
		expect(inspection.shouldFallback).toBe(true);
		expect(inspection.reason).toBe('complex_mixed_structure');
	});

	// 空行のないパートの junk 行は数えない。part_header_malformed にはならず、既存の判定結果のまま
	// (alternative / mixed のどちらも shouldFallback=false、reason なし)
	it.each(['alternative', 'mixed'])('does not report a part that reaches the next boundary without an empty line (%s)', async (subtype) => {
		const raw = [
			'From: Sender <sender@example.com>',
			`Content-Type: multipart/${subtype}; boundary="b"`,
			'',
			'--b',
			'Content-Type: text/plain; charset=utf-8',
			'no separator line',
			'--b',
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>html</p>',
			'--b--',
		].join('\r\n');

		const inspection = await inspectMultipartFallbackForRawInput(raw);
		expect(inspection.shouldFallback).toBe(false);
		expect(inspection.reason).toBeUndefined();
	});

	// 既知のギャップ(既存): 空行のないパートでは text(postal-mime)と送信バイト(compat)が食い違う
	it.todo('keeps text and bodyBytes consistent for a multipart/alternative part without an empty line');

	it('keeps the existing reason when a junk part header line comes with another anomaly', async () => {
		const raw = [
			'From: Sender <sender@example.com>',
			'Content-Type: multipart/mixed; boundary="b"',
			'',
			'--b',
			'Content-Type: text/plain; charset=utf-8',
			'broken line',
			'',
			'plain body',
		].join('\r\n');

		const inspection = await inspectMultipartFallbackForRawInput(raw);
		expect(inspection.reason).toBe('missing_closing_boundary');
	});

	function junkThenRaw(subtype: 'alternative' | 'mixed', ...afterJunk: string[]): string {
		return [
			'From: Sender <sender@example.com>',
			`Content-Type: multipart/${subtype}; boundary="b"`,
			'',
			'--b',
			'Content-Type: text/plain',
			'junk line',
			...afterJunk,
			'',
			'aGVsbG8=',
			'--b--',
		].join('\r\n');
	}

	// junk 行の後の「境界に似た行」は区切りではないので、junk 検出をリセットしない
	it.each(['--bogus', '--b-x', '--b--x'])('still reports a junk line followed by the lookalike line %s', async (lookalike) => {
		const raw = junkThenRaw('alternative', lookalike, 'Content-Transfer-Encoding: base64');
		const inspection = await inspectMultipartFallbackForRawInput(raw);
		expect(inspection.shouldFallback).toBe(true);
		expect(inspection.reason).toBe('part_header_malformed');

		const parsed = await parseRaw(raw);
		expect(parsed.text).toBe(new TextDecoder().decode(parsed[parsedBodyBytesSymbol]?.text));
	});

	it('does not take a body line that merely starts with the boundary for a delimiter', async () => {
		const raw = [
			'From: Sender <sender@example.com>',
			'Content-Type: multipart/alternative; boundary="b"',
			'',
			'--b',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'hello',
			'--bar is a line',
			'some text',
			'',
			'more',
			'--b',
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>html</p>',
			'--b--',
		].join('\r\n');

		const inspection = await inspectMultipartFallbackForRawInput(raw);
		expect(inspection.reason).not.toBe('part_header_malformed');
		const expected = await PostalMime.parse(raw);
		const parsed = await parseRaw(raw);
		expect(parsed.text).toBe(expected.text);
		// bodyBytes は境界を部分文字列で照合する既存の compat リーダー由来で、この形では食い違う(既存の compat の制約のため比較しない)
	});

	it('ends the scan at a closing delimiter with trailing whitespace', async () => {
		const raw = ['From: Sender <sender@example.com>', 'Content-Type: multipart/alternative; boundary="b"', '', '--b', 'Content-Type: text/plain', '', 'hello', '--b--  ', 'epilogue junk', '', 'tail'].join(
			'\r\n',
		);
		const inspection = await inspectMultipartFallbackForRawInput(raw);
		expect(inspection.reason).not.toBe('part_header_malformed');
	});

	it('reports a junk line in the second part', async () => {
		const raw = [
			'From: Sender <sender@example.com>',
			'Content-Type: multipart/alternative; boundary="b"',
			'',
			'--b',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'plain body',
			'--b',
			'Content-Type: text/html; charset=utf-8',
			'broken line',
			'',
			'<p>html</p>',
			'--b--',
		].join('\r\n');

		const inspection = await inspectMultipartFallbackForRawInput(raw);
		expect(inspection.shouldFallback).toBe(true);
		expect(inspection.reason).toBe('part_header_malformed');
		const parsed = await parseRaw(raw);
		expect(new TextDecoder().decode(parsed[parsedBodyBytesSymbol]?.text)).toBe(parsed.text);
		expect(new TextDecoder().decode(parsed[parsedBodyBytesSymbol]?.html)).toBe(parsed.html);
	});

	it('scans a line that repeats the delimiter text in linear time', async () => {
		// 区切り文字列が 1 行に大量に並ぶ入力でも、行頭でない出現は行末を探さずに読み飛ばす
		// (二次時間だと 80 万回の反復は既定のテストタイムアウトを大きく超える)
		const raw = [
			'From: Sender <sender@example.com>',
			'Content-Type: multipart/alternative; boundary="b"',
			'',
			'--b',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'hi',
			'--b'.repeat(800_000),
			'--b--',
		].join('\r\n');

		const inspection = await inspectMultipartFallbackForRawInput(raw);
		expect(inspection.reason).not.toBe('part_header_malformed');
	});

	// 既知のギャップ: ネストしたマルチパートの内側のパートヘッダーは検査しない(compat も平坦に扱う既存の制約)
	it.todo('falls back when a nested inner part header contains a junk line');
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

	it('uses the first Content-Type when the header is duplicated', async () => {
		// postal-mime と同じく最初の出現(text/plain)を採用し、後のマルチパート宣言は使わない
		const raw = [
			'From: Sender <sender@example.com>',
			'Content-Type: text/plain; charset=utf-8',
			'Content-Type: multipart/alternative; boundary="b"',
			'',
			'--b',
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>x</p>',
			'--b--',
		].join('\r\n');

		const inspection = await inspectMultipartFallbackForRawInput(raw);
		expect(inspection.isMultipart).toBe(false);
		expect(inspection.contentType).toBe('text/plain; charset=utf-8');
		const parsed = await parseRaw(raw);
		expect(parsed.html).toBeUndefined();
		expect(parsed.text).toContain('<p>x</p>');
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
