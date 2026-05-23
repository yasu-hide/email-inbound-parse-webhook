export const parsedBodyBytesSymbol: unique symbol = Symbol('parsedBodyBytes');

export type BodyBytes = {
	text?: Uint8Array;
	html?: Uint8Array;
};

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
	[parsedBodyBytesSymbol]?: BodyBytes;
};

export type DecodedBody = {
	text: string;
	charset?: string;
	bytes: Uint8Array;
};
