import {
	base64ToUint8Array,
	decodeBytesWithFallback,
	quotedPrintableToUint8Array,
} from '../email-normalizer';
import { binaryStringToUint8Array } from '../email-normalizer-utils';
import type { DecodedBody } from './types';

function bytesToBinaryString(bytes: Uint8Array): string {
	let out = '';
	for (const byte of bytes) out += String.fromCharCode(byte);
	return out;
}

export function decodeBody(raw: string | Uint8Array, contentTransferEncoding: string, declaredCharset: string | undefined): DecodedBody {
	const rawBytes = raw instanceof Uint8Array ? raw : binaryStringToUint8Array(raw);
	const rawText = raw instanceof Uint8Array ? bytesToBinaryString(raw) : raw;
	let bodyBytes: Uint8Array;
	if (contentTransferEncoding === 'base64') {
		try {
			bodyBytes = base64ToUint8Array(rawText);
		} catch (e) {
			bodyBytes = rawBytes;
		}
	} else if (contentTransferEncoding === 'quoted-printable') {
		try {
			bodyBytes = quotedPrintableToUint8Array(rawText);
		} catch (e) {
			bodyBytes = rawBytes;
		}
	} else {
		bodyBytes = rawBytes;
	}
	return {
		...decodeBytesWithFallback(bodyBytes, declaredCharset),
		bytes: bodyBytes,
	};
}
