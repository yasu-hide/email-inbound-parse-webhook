import {
	binaryStringToUint8Array,
	decodeBytes,
	hasIso2022JpEscape,
	isAsciiOnly,
	isValidUtf8,
	normalizeCharset,
	scoreDecodedText,
} from './email-normalizer-utils';

export function parseCharset(contentType: string | undefined): string | undefined {
	if (!contentType) return undefined;
	const m = contentType.match(/charset\s*=\s*"?([^";\s]+)"?/i);
	return m ? m[1].toLowerCase() : undefined;
}

export function base64ToUint8Array(b64: string): Uint8Array {
	const bin = atob(b64.replace(/\s+/g, ''));
	const arr = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
	return arr;
}

export function quotedPrintableToUint8Array(qp: string): Uint8Array {
	qp = qp.replace(/=(?:\r\n|\n)/g, '');
	const bytes: number[] = [];
	for (let i = 0; i < qp.length; i++) {
		const ch = qp[i];
		if (ch === '=' && i + 2 < qp.length) {
			const hex = qp.substr(i + 1, 2);
			if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
				bytes.push(parseInt(hex, 16));
				i += 2;
				continue;
			}
		}
		bytes.push(qp.charCodeAt(i));
	}
	return new Uint8Array(bytes);
}

export function decodeBytesWithFallback(bytes: Uint8Array, declaredCharset?: string): { text: string; charset?: string } {
	const normalizedDeclared = normalizeCharset(declaredCharset);
	if (isAsciiOnly(bytes)) {
		return { text: decodeBytes(bytes, normalizedDeclared || 'utf-8'), charset: normalizedDeclared || 'utf-8' };
	}

	const candidates: string[] = [];
	const addCandidate = (charset: string | undefined) => {
		const cs = normalizeCharset(charset);
		if (!cs) return;
		if (!candidates.includes(cs)) candidates.push(cs);
	};

	addCandidate(normalizedDeclared);
	addCandidate('utf-8');
	addCandidate('windows-31j');
	addCandidate('euc-jp');
	addCandidate('iso-2022-jp');
	addCandidate('iso-8859-1');

	const hasIsoEscape = hasIso2022JpEscape(bytes);
	const utf8Valid = isValidUtf8(bytes);
	const priority: Record<string, number> = {
		'utf-8': 0,
		'windows-31j': 1,
		'euc-jp': 2,
		'iso-2022-jp': 3,
		'iso-8859-1': 4,
	};

	let bestText = decodeBytes(bytes, normalizedDeclared || 'utf-8');
	let bestScore = scoreDecodedText(bestText);
	let bestCharset = normalizedDeclared || 'utf-8';

	if (!normalizedDeclared && utf8Valid) {
		bestText = decodeBytes(bytes, 'utf-8');
		bestScore = scoreDecodedText(bestText);
		bestCharset = 'utf-8';
	}

	for (const cs of candidates) {
		if (cs === 'iso-2022-jp' && !hasIsoEscape && normalizedDeclared !== 'iso-2022-jp') {
			continue;
		}
		try {
			const decoded = new TextDecoder(cs).decode(bytes);
			const score = scoreDecodedText(decoded);
			const currentPriority = priority[cs] ?? 99;
			const bestPriority = priority[bestCharset] ?? 99;
			if (score < bestScore || (score === bestScore && currentPriority < bestPriority)) {
				bestText = decoded;
				bestScore = score;
				bestCharset = cs;
			}
		} catch (e) {
			continue;
		}
	}

	return { text: bestText, charset: bestCharset };
}

function decodeHeaderTextSegment(segment: string): string {
	if (!segment) return '';
	const bytes = binaryStringToUint8Array(segment);
	if (isAsciiOnly(bytes)) return segment;
	return decodeBytesWithFallback(bytes).text;
}

export function decodeHeaderValue(rawValue: string): string {
	if (!rawValue) return rawValue;
	const normalized = rawValue.replace(/(\?=)\s+(=\?)/g, '$1$2');
	const encodedWordPattern = /=\?([^?]+)\?([bqBQ])\?([^?]+)\?=/g;
	let result = '';
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = encodedWordPattern.exec(normalized)) !== null) {
		result += decodeHeaderTextSegment(normalized.slice(lastIndex, match.index));

		const [, charset, encoding, encodedText] = match;
		const normalizedCharset = normalizeCharset(charset || 'utf-8');
		if ((encoding || '').toLowerCase() === 'b') {
			try {
				result += decodeBytesWithFallback(base64ToUint8Array(encodedText), normalizedCharset).text;
			} catch (e) {
				result += encodedText;
			}
		} else {
			const qp = encodedText.replace(/_/g, ' ');
			try {
				result += decodeBytesWithFallback(quotedPrintableToUint8Array(qp), normalizedCharset).text;
			} catch (e) {
				result += qp;
			}
		}

		lastIndex = encodedWordPattern.lastIndex;
	}

	result += decodeHeaderTextSegment(normalized.slice(lastIndex));
	return result;
}
