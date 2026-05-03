import { parseCharset } from '../email-normalizer';
import type { DecodedBody, ParsedResult } from './types';

type SinglepartParseArgs = {
	reader: ReadableStreamDefaultReader<Uint8Array>;
	decoder: TextDecoder;
	initialBuffer: string;
	headers: Record<string, string>;
	contentType: string;
	decodeBody: (raw: string, contentTransferEncoding: string, declaredCharset: string | undefined) => DecodedBody;
};

export async function parseSinglepartBody(args: SinglepartParseArgs): Promise<Pick<ParsedResult, 'text' | 'textCharset' | 'html' | 'htmlCharset'>> {
	const { reader, decoder, headers, contentType, decodeBody } = args;
	let buffer = args.initialBuffer;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		if (buffer.length > 10 * 1024 * 1024) break;
	}

	const cte = (headers['content-transfer-encoding'] || '').toLowerCase();
	const headerCharset = parseCharset(contentType);
	const decodedBody = decodeBody(buffer, cte, headerCharset);
	const body = decodedBody.text;

	if (/text\/html/i.test(contentType)) {
		return {
			htmlCharset: decodedBody.charset,
			html: body,
		};
	}

	return {
		textCharset: decodedBody.charset,
		text: body,
	};
}
