export type ParsedResult = {
	headers: Record<string, string>;
	rawHeaders?: Record<string, string>;
	from?: string;
	fromCharset?: string;
	to?: string;
	toCharset?: string;
	cc?: string;
	ccCharset?: string;
	subject?: string;
	subjectCharset?: string;
	text?: string;
	textCharset?: string;
	textBytes?: Uint8Array;
	html?: string;
	htmlCharset?: string;
	htmlBytes?: Uint8Array;
};

export type DecodedBody = {
	text: string;
	charset?: string;
	bytes: Uint8Array;
};
