export type RawEmailInput = string | Uint8Array;

export type BaselineCase = {
	id: string;
	group: 'normal' | 'error';
	description: string;
	raw: RawEmailInput;
	envelope?: {
		from?: string;
		to?: string;
	};
};

function joinLines(lines: string[]): string {
	return lines.join('\r\n');
}

function basicHeaders(overrides: Partial<Record<'from' | 'to' | 'subject' | 'contentType' | 'cte' | 'cc', string>> = {}): string[] {
	const headers = [
		`From: ${overrides.from ?? 'Sender <sender@example.com>'}`,
		`To: ${overrides.to ?? 'Receiver <receiver@example.com>'}`,
	];
	if (overrides.cc) headers.push(`Cc: ${overrides.cc}`);
	headers.push(`Subject: ${overrides.subject ?? 'baseline case'}`);
	headers.push(`Content-Type: ${overrides.contentType ?? 'text/plain; charset=utf-8'}`);
	headers.push(`Content-Transfer-Encoding: ${overrides.cte ?? '7bit'}`);
	return headers;
}

function buildPlain(body: string, overrides: Parameters<typeof basicHeaders>[0] = {}): string {
	return joinLines([...basicHeaders(overrides), '', body]);
}

function latin1SubjectRaw(subjectPrefix: string): Uint8Array {
	return new Uint8Array([
		...new TextEncoder().encode('From: Sender <sender@example.com>\r\n'),
		...new TextEncoder().encode('To: Receiver <receiver@example.com>\r\n'),
		...new TextEncoder().encode(`Subject: ${subjectPrefix}`),
		0xe9,
		...new TextEncoder().encode('\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\nhello'),
	]);
}

export const baselineCases: BaselineCase[] = [
	{ id: 'N01', group: 'normal', description: 'ascii plain text', raw: buildPlain('hello') },
	{ id: 'N02', group: 'normal', description: 'RFC2047 subject B', raw: buildPlain('hello', { subject: '=?UTF-8?B?5ZWT5piO6aSo?=' }) },
	{ id: 'N03', group: 'normal', description: 'RFC2047 subject Q', raw: buildPlain('hello', { subject: '=?UTF-8?Q?=E5=95=93=E6=98=8E=E9=A4=A8?=' }) },
	{
		id: 'N04',
		group: 'normal',
		description: 'folded RFC2047 subject',
		raw: joinLines([
			...basicHeaders({ subject: '=?UTF-8?B?5ZWT?=' }),
			' =?UTF-8?B?5piO6aSo?=',
			'',
			'hello',
		]),
	},
	{ id: 'N05', group: 'normal', description: 'malformed encoded-word subject', raw: buildPlain('hello', { subject: '=?UTF-8?B?5ZWT5piO6aSo?' }) },
	{
		id: 'N06',
		group: 'normal',
		description: 'encoded from and to display names',
		raw: buildPlain('hello', {
			from: '=?UTF-8?B?5ZWT5piO6aSo?= <sender@example.com>',
			to: '=?UTF-8?B?5Y+X5L+h6ICF?= <receiver@example.com>',
		}),
	},
	{
		id: 'N07',
		group: 'normal',
		description: 'folded encoded To display name',
		raw: buildPlain('hello', { to: '=?UTF-8?B?5Y+X?=\r\n =?UTF-8?B?5L+h6ICF?= <receiver@example.com>' }),
	},
	{
		id: 'N08',
		group: 'normal',
		description: 'encoded Cc display name',
		raw: buildPlain('hello', { cc: '=?UTF-8?B?5Y+X5L+h6ICF?= <cc@example.com>' }),
	},
	{
		id: 'N09',
		group: 'normal',
		description: 'folded encoded Cc display name',
		raw: buildPlain('hello', { cc: '=?UTF-8?B?5Y+X?=\r\n =?UTF-8?B?5L+h6ICF?= <cc@example.com>' }),
	},
	{ id: 'N10', group: 'normal', description: 'missing charset text/plain', raw: buildPlain('日本語テキスト', { contentType: 'text/plain' }) },
	{
		id: 'N11',
		group: 'normal',
		description: 'utf-8 qp text/plain',
		raw: buildPlain('hello=20world=21', { cte: 'quoted-printable' }),
	},
	{
		id: 'N12',
		group: 'normal',
		description: 'iso-2022-jp qp body',
		raw: buildPlain('=1B$B$3$s$K$A$O=1B(B', {
			subject: '=?ISO-2022-JP?B?GyRCNzxMQDRbRn5CYDw8GyhC?=',
			contentType: 'text/plain; charset=ISO-2022-JP',
			cte: 'quoted-printable',
		}),
	},
	{ id: 'N13', group: 'normal', description: 'latin1 raw subject bytes', raw: latin1SubjectRaw('caf') },
	{
		id: 'N14',
		group: 'normal',
		description: 'multipart alternative text+html',
		raw: joinLines([
			...basicHeaders({ contentType: 'multipart/alternative; boundary="----n14"' }),
			'',
			'------n14',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'plain n14',
			'------n14',
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>html n14</p>',
			'------n14--',
		]),
	},
	{
		id: 'N15',
		group: 'normal',
		description: 'shift_jis declared plain text',
		raw: buildPlain('ascii with shiftjis declaration', { contentType: 'text/plain; charset=Shift_JIS' }),
	},
	{ id: 'N16', group: 'normal', description: 'html only', raw: buildPlain('<h1>Hello</h1>', { contentType: 'text/html; charset=utf-8' }) },
	{ id: 'N17', group: 'normal', description: 'quoted-printable text only', raw: buildPlain('aGVsbG8=0A', { cte: 'quoted-printable' }) },
	{ id: 'N18', group: 'normal', description: 'base64 text only', raw: buildPlain('aGVsbG8gd29ybGQh', { cte: 'base64' }) },
	{
		id: 'N19',
		group: 'normal',
		description: 'envelope fallback no from/to headers',
		raw: joinLines([
			'Subject: envelope fallback',
			'Content-Type: text/plain; charset=utf-8',
			'Content-Transfer-Encoding: 7bit',
			'',
			'hello',
		]),
		envelope: { from: 'env-from@example.com', to: 'env-to@example.com' },
	},
	{
		id: 'N20',
		group: 'normal',
		description: 'required payload fields only',
		raw: joinLines(['Content-Type: text/plain; charset=utf-8', '', 'hello']),
		envelope: { from: 'sender@example.com', to: 'receiver@example.com' },
	},
	{ id: 'N21', group: 'normal', description: 'ascii headers only', raw: buildPlain('hello', { subject: 'ascii subject' }) },
	{ id: 'N22', group: 'normal', description: 'latin1 raw bytes subject variant', raw: latin1SubjectRaw('resume ') },
	{
		id: 'N23',
		group: 'normal',
		description: 'nested multipart mixed + alternative (healthy)',
		raw: joinLines([
			...basicHeaders({ contentType: 'multipart/mixed; boundary="----outer"' }),
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
		]),
	},
	{
		id: 'N24',
		group: 'normal',
		description: 'message/rfc822 part included',
		raw: joinLines([
			...basicHeaders({ contentType: 'multipart/mixed; boundary="----n24"' }),
			'',
			'------n24',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'outer text',
			'------n24',
			'Content-Type: message/rfc822',
			'',
			'From: nested@example.com',
			'To: nested2@example.com',
			'Subject: nested message',
			'',
			'nested body',
			'------n24--',
		]),
	},
	{ id: 'E01', group: 'error', description: 'malformed encoded-word subject', raw: buildPlain('hello', { subject: '=?UTF-8?Q?bad=ZZ?=' }) },
	{
		id: 'E02',
		group: 'error',
		description: 'malformed folded header',
		raw: joinLines([
			'From: Sender <sender@example.com>',
			'To: Receiver <receiver@example.com>',
			'Subject: valid prefix',
			'broken continuation without colon',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'hello',
		]),
	},
	{
		id: 'E03',
		group: 'error',
		description: 'missing closing boundary',
		raw: joinLines([
			...basicHeaders({ contentType: 'multipart/mixed; boundary="----e03"' }),
			'',
			'------e03',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'plain e03',
			'------e03',
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>html e03</p>',
		]),
	},
	{
		id: 'E04',
		group: 'error',
		description: 'boundary mismatch declaration vs actual',
		raw: joinLines([
			...basicHeaders({ contentType: 'multipart/mixed; boundary="----declared"' }),
			'',
			'------actual',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'hello mismatch',
			'------actual--',
		]),
	},
	{
		id: 'E05',
		group: 'error',
		description: 'oversized header near limit',
		raw: buildPlain('hello', { subject: `huge-${'A'.repeat(32 * 1024)}` }),
	},
	{
		id: 'E06',
		group: 'error',
		description: 'declared charset mismatched with bytes',
		raw: buildPlain('caf=E9', { contentType: 'text/plain; charset=utf-8', cte: 'quoted-printable' }),
	},
	{
		id: 'E07',
		group: 'error',
		description: 'missing opening boundary marker in body',
		raw: joinLines([
			...basicHeaders({ contentType: 'multipart/mixed; boundary="----e07"' }),
			'',
			'------actual',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'plain e07',
			'------actual--',
		]),
	},
	{
		id: 'E08',
		group: 'error',
		description: 'part header separator is malformed',
		raw: joinLines([
			...basicHeaders({ contentType: 'multipart/mixed; boundary="----e08"' }),
			'',
			'------e08',
			'Content-Type: text/plain; charset=utf-8',
			'Content-Transfer-Encoding: 7bit',
			'plain e08 without header-body separator',
			'------e08--',
		]),
	},
];
