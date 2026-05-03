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
	html?: string;
	htmlCharset?: string;
};

export type DecodedBody = {
	text: string;
	charset?: string;
};
