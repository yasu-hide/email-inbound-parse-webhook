import {
	base64ToUint8Array,
	decodeBytesWithFallback,
	quotedPrintableToUint8Array,
} from '../email-normalizer';
import type { DecodedBody } from './types';

export function decodeBody(raw: string, contentTransferEncoding: string, declaredCharset: string | undefined): DecodedBody {
	let bodyBytes: Uint8Array;
	if (contentTransferEncoding === 'base64') {
		try {
			bodyBytes = base64ToUint8Array(raw);
		} catch (e) {
			bodyBytes = new TextEncoder().encode(raw);
		}
	} else if (contentTransferEncoding === 'quoted-printable') {
		try {
			bodyBytes = quotedPrintableToUint8Array(raw);
		} catch (e) {
			bodyBytes = new TextEncoder().encode(raw);
		}
	} else {
		bodyBytes = new TextEncoder().encode(raw);
	}
	return decodeBytesWithFallback(bodyBytes, declaredCharset);
}
