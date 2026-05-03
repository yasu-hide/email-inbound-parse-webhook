import { parseEmailStreamWithPostalMime } from './email-parser/postal-mime-adapter';
import type { ParsedResult } from './email-parser/types';

export type { ParsedResult } from './email-parser/types';

export async function parseEmailStream(stream: ReadableStream): Promise<ParsedResult> {
	if (!stream || typeof (stream as any).getReader !== 'function') {
		throw new TypeError('stream.getReader is not a function');
	}
	return parseEmailStreamWithPostalMime(stream);
}
