import PostalMime, { type Address, type Mailbox } from 'postal-mime';
import { parseCharset } from '../email-normalizer';
import { normalizeCharset } from '../email-normalizer-utils';
import { decodeBody } from './body-decoder';
import { decodeHeaderMap, parseRawHeaderMap } from './header-map';
import type { ParsedResult } from '../email-parser';

function formatMailbox(mailbox: Mailbox): string {
	if (mailbox.name && mailbox.address) {
		return `${mailbox.name} <${mailbox.address}>`;
	}
	return mailbox.address || mailbox.name;
}

function formatAddress(address: Address): string[] {
	if ('group' in address && Array.isArray(address.group)) {
		return address.group.map((mailbox) => formatMailbox(mailbox));
	}
	if ('address' in address && address.address) {
		return [formatMailbox(address)];
	}
	if ('name' in address && address.name) {
		return [address.name];
	}
	return [];
}

function formatAddressList(addresses?: Address[]): string | undefined {
	if (!addresses?.length) return undefined;
	const formatted = addresses.flatMap((address) => formatAddress(address)).filter(Boolean);
	if (!formatted.length) return undefined;
	return formatted.join(', ');
}

function buildHeaderMap(headers: Array<{ key: string; value: string }>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const header of headers) {
		out[header.key] = out[header.key] ? `${out[header.key]}, ${header.value}` : header.value;
	}
	return out;
}

function stripSingleTrailingNewline(value: string): string {
	return value.replace(/\r?\n$/, '');
}

function findHeaderSection(bytes: Uint8Array): { headerEnd: number; separatorLength: number } {
	for (let i = 0; i < bytes.length - 3; i++) {
		if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
			return { headerEnd: i, separatorLength: 4 };
		}
	}
	for (let i = 0; i < bytes.length - 1; i++) {
		if (bytes[i] === 10 && bytes[i + 1] === 10) {
			return { headerEnd: i, separatorLength: 2 };
		}
	}
	return { headerEnd: bytes.length, separatorLength: 0 };
}

function parseHeadersFromRaw(raw: ArrayBuffer): { rawHeaders: Record<string, string>; decodedHeaders: Record<string, string> } {
	const bytes = new Uint8Array(raw);
	const { headerEnd } = findHeaderSection(bytes);
	const headerText = new TextDecoder('iso-8859-1').decode(bytes.slice(0, headerEnd));
	const rawHeaders = parseRawHeaderMap(headerText);
	const decodedHeaders = decodeHeaderMap(rawHeaders);
	return { rawHeaders, decodedHeaders };
}

function extractRawBody(raw: ArrayBuffer): string {
	const bytes = new Uint8Array(raw);
	const { headerEnd, separatorLength } = findHeaderSection(bytes);
	return new TextDecoder('iso-8859-1').decode(bytes.slice(headerEnd + separatorLength));
}

type MultipartCompatResult = Pick<ParsedResult, 'text' | 'textCharset' | 'html' | 'htmlCharset'>;

function extractMultipartBoundary(contentType: string): string | null {
	const match = contentType.match(/boundary="?([^";]+)"?/i);
	return match ? `--${match[1]}` : null;
}

function parsePartHeaders(rawHeaders: string): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const line of rawHeaders.split(/\r?\n/)) {
		const match = line.match(/^([^:]+):\s*(.*)$/);
		if (!match) continue;
		const key = match[1].toLowerCase();
		const value = match[2];
		headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
	}
	return headers;
}

function parseMultipartCompat(rawBody: string, contentTypeHeader: string): MultipartCompatResult {
	const boundary = extractMultipartBoundary(contentTypeHeader);
	if (!boundary) return {};

	let buffer = rawBody;
	const result: MultipartCompatResult = {};
	const startIdx = buffer.indexOf(boundary);
	if (startIdx !== -1) {
		buffer = buffer.slice(startIdx + boundary.length);
	}

	while (buffer.length > 0) {
		let separator = '\r\n\r\n';
		let separatorIndex = buffer.indexOf(separator);
		if (separatorIndex === -1) {
			separator = '\n\n';
			separatorIndex = buffer.indexOf(separator);
		}
		if (separatorIndex === -1) {
			break;
		}

		const partRawHeaders = buffer.slice(0, separatorIndex);
		buffer = buffer.slice(separatorIndex + separator.length);

		const partHeaders = parsePartHeaders(partRawHeaders);
		const partContentType = partHeaders['content-type'] || 'text/plain';
		const disposition = (partHeaders['content-disposition'] || '').toLowerCase();
		const contentTransferEncoding = (partHeaders['content-transfer-encoding'] || '').toLowerCase();
		const isText = /text\/plain/i.test(partContentType);
		const isHtml = /text\/html/i.test(partContentType);
		const isAttachment = disposition.includes('attachment') || disposition.includes('filename=');

		let boundaryIndex = buffer.indexOf(`\r\n${boundary}`);
		let boundaryLength = (`\r\n${boundary}`).length;
		if (boundaryIndex === -1) {
			boundaryIndex = buffer.indexOf(`\n${boundary}`);
			boundaryLength = (`\n${boundary}`).length;
		}

		let partContent = '';
		if (boundaryIndex !== -1) {
			partContent = buffer.slice(0, boundaryIndex);
			buffer = buffer.slice(boundaryIndex + boundaryLength);
		} else {
			partContent = buffer;
			buffer = '';
		}

		if (!isAttachment && (isText || isHtml)) {
			const raw = partContent.replace(/^(\r?\n)/, '');
			const decoded = decodeBody(raw, contentTransferEncoding, parseCharset(partContentType));
			if (isText) {
				result.textCharset = decoded.charset;
				result.text = result.text ? `${result.text}\n${decoded.text}` : decoded.text;
			}
			if (isHtml) {
				result.htmlCharset = decoded.charset;
				result.html = result.html ? `${result.html}\n${decoded.text}` : decoded.text;
			}
		}

		if (buffer.startsWith('--')) {
			break;
		}
	}

	return result;
}

function isMultipartAlternative(contentType: string): boolean {
	return /^multipart\/alternative\b/i.test(contentType);
}

function isMultipartMixed(contentType: string): boolean {
	return /^multipart\/mixed\b/i.test(contentType);
}

export type MultipartFallbackReason =
	| 'non_alternative_multipart'
	| 'missing_boundary'
	| 'missing_opening_boundary'
	| 'missing_closing_boundary'
	| 'part_header_separator_missing'
	| 'part_delimiter_misaligned'
	| 'complex_mixed_structure'
	| 'missing_text_and_html'
	| 'replacement_character_detected';

type MultipartFallbackDecision = {
	shouldFallback: boolean;
	reason?: MultipartFallbackReason;
};

export type MultipartFallbackInspection = {
	isMultipart: boolean;
	contentType?: string;
	shouldFallback: boolean;
	reason?: MultipartFallbackReason;
};

function detectMultipartAnomaly(rawBody: string, contentTypeHeader: string): MultipartFallbackReason | null {
	const boundary = extractMultipartBoundary(contentTypeHeader);
	if (!boundary) return 'missing_boundary';
	const hasOpeningBoundary = rawBody.includes(boundary);
	const hasClosingBoundary = rawBody.includes(`${boundary}--`);
	if (!hasOpeningBoundary) {
		return 'missing_opening_boundary';
	}
	if (!hasClosingBoundary) {
		return 'missing_closing_boundary';
	}
	return null;
}

function shouldFallbackAlternative(
	contentType: string,
	contentTypeHeader: string,
	rawBody: string,
	parsed: { text?: string; html?: string },
	): MultipartFallbackDecision {
	if (!contentType.includes('multipart/')) {
		return { shouldFallback: false };
	}
	if (!isMultipartAlternative(contentType)) {
		return { shouldFallback: false };
	}
	const anomaly = detectMultipartAnomaly(rawBody, contentTypeHeader);
	if (anomaly) {
		return { shouldFallback: true, reason: anomaly };
	}
	if (!parsed.text && !parsed.html) {
		return { shouldFallback: true, reason: 'missing_text_and_html' };
	}
	if (parsed.text?.includes('\uFFFD') || parsed.html?.includes('\uFFFD')) {
		return { shouldFallback: true, reason: 'replacement_character_detected' };
	}
	return { shouldFallback: false };
}

type MixedStructureKind = 'simple' | 'nested_alternative' | 'complex';

type MixedStructureDecision = {
	kind: MixedStructureKind;
	reason?: MultipartFallbackReason;
};

function analyzeMixedStructure(rawBody: string, contentTypeHeader: string): MixedStructureDecision {
	const boundary = extractMultipartBoundary(contentTypeHeader);
	if (!boundary) {
		return { kind: 'complex', reason: 'missing_boundary' };
	}

	let buffer = rawBody;
	const startIdx = buffer.indexOf(boundary);
	if (startIdx === -1) {
		return { kind: 'complex', reason: 'missing_opening_boundary' };
	}
	buffer = buffer.slice(startIdx + boundary.length);
	let hasNestedAlternative = false;

	while (buffer.length > 0) {
		let separator = '\r\n\r\n';
		let separatorIndex = buffer.indexOf(separator);
		if (separatorIndex === -1) {
			separator = '\n\n';
			separatorIndex = buffer.indexOf(separator);
		}
		if (separatorIndex === -1) {
			return { kind: 'complex', reason: 'part_header_separator_missing' };
		}

		const partRawHeaders = buffer.slice(0, separatorIndex);
		buffer = buffer.slice(separatorIndex + separator.length);

		const partHeaders = parsePartHeaders(partRawHeaders);
		const partContentType = (partHeaders['content-type'] || 'text/plain').toLowerCase();
		const disposition = (partHeaders['content-disposition'] || '').toLowerCase();
		const isAttachment = disposition.includes('attachment') || disposition.includes('filename=');
		const isText = /^text\/(plain|html)\b/i.test(partContentType);
		const isMultipart = partContentType.startsWith('multipart/');
		const isNestedAlternative = /^multipart\/alternative\b/i.test(partContentType);

		if (isMultipart && isNestedAlternative) {
			hasNestedAlternative = true;
		} else if (isMultipart) {
			return { kind: 'complex', reason: 'complex_mixed_structure' };
		}
		if (!isMultipart && !isAttachment && !isText) {
			return { kind: 'complex', reason: 'complex_mixed_structure' };
		}

		let boundaryIndex = buffer.indexOf(`\r\n${boundary}`);
		let boundaryLength = (`\r\n${boundary}`).length;
		if (boundaryIndex === -1) {
			boundaryIndex = buffer.indexOf(`\n${boundary}`);
			boundaryLength = (`\n${boundary}`).length;
		}
		if (boundaryIndex === -1) {
			return { kind: 'complex', reason: 'part_delimiter_misaligned' };
		}

		buffer = buffer.slice(boundaryIndex + boundaryLength);
		if (buffer.startsWith('--')) {
			return { kind: hasNestedAlternative ? 'nested_alternative' : 'simple' };
		}
	}

	return { kind: 'complex', reason: 'part_delimiter_misaligned' };
}

function shouldFallbackMixed(
	contentType: string,
	contentTypeHeader: string,
	rawBody: string,
	parsed: { text?: string; html?: string },
): MultipartFallbackDecision {
	if (!contentType.includes('multipart/')) {
		return { shouldFallback: false };
	}
	if (isMultipartAlternative(contentType)) {
		return { shouldFallback: false };
	}
	if (!isMultipartMixed(contentType)) {
		return { shouldFallback: true, reason: 'non_alternative_multipart' };
	}
	const anomaly = detectMultipartAnomaly(rawBody, contentTypeHeader);
	if (anomaly) {
		return { shouldFallback: true, reason: anomaly };
	}
	const structure = analyzeMixedStructure(rawBody, contentTypeHeader);
	if (structure.kind === 'complex') {
		return { shouldFallback: true, reason: structure.reason ?? 'complex_mixed_structure' };
	}
	if (!parsed.text && !parsed.html) {
		return { shouldFallback: true, reason: 'missing_text_and_html' };
	}
	if (parsed.text?.includes('\uFFFD') || parsed.html?.includes('\uFFFD')) {
		return { shouldFallback: true, reason: 'replacement_character_detected' };
	}
	return { shouldFallback: false };
}

function shouldUseMultipartCompat(
	contentType: string,
	contentTypeHeader: string,
	rawBody: string,
	parsed: { text?: string; html?: string },
): MultipartFallbackDecision {
	if (!contentType.includes('multipart/')) {
		return { shouldFallback: false };
	}
	if (!isMultipartAlternative(contentType)) {
		return shouldFallbackMixed(contentType, contentTypeHeader, rawBody, parsed);
	}
	return shouldFallbackAlternative(contentType, contentTypeHeader, rawBody, parsed);
}

function toContiguousArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export async function inspectMultipartFallbackForRawInput(rawInput: string | Uint8Array): Promise<MultipartFallbackInspection> {
	const bytes = rawInput instanceof Uint8Array ? rawInput : new TextEncoder().encode(rawInput);
	const raw = toContiguousArrayBuffer(bytes);
	const parsed = await PostalMime.parse(raw);
	const { rawHeaders } = parseHeadersFromRaw(raw);
	const contentTypeHeader = rawHeaders['content-type'] || '';
	const contentType = contentTypeHeader.toLowerCase();

	if (!contentType.includes('multipart/')) {
		return {
			isMultipart: false,
			contentType: contentTypeHeader || undefined,
			shouldFallback: false,
		};
	}

	const rawBody = extractRawBody(raw);
	const decision = shouldUseMultipartCompat(contentType, contentTypeHeader, rawBody, parsed);
	return {
		isMultipart: true,
		contentType: contentTypeHeader,
		shouldFallback: decision.shouldFallback,
		reason: decision.reason,
	};
}

export async function parseEmailStreamWithPostalMime(stream: ReadableStream): Promise<ParsedResult> {
	const raw = await new Response(stream).arrayBuffer();
	const parsed = await PostalMime.parse(raw);
	const headersFromPostal = buildHeaderMap(parsed.headers);
	const { rawHeaders, decodedHeaders } = parseHeadersFromRaw(raw);

	const result: ParsedResult = {
		headers: Object.keys(decodedHeaders).length > 0 ? decodedHeaders : headersFromPostal,
		rawHeaders: Object.keys(rawHeaders).length > 0 ? rawHeaders : { ...headersFromPostal },
	};

	const from = parsed.from ? formatAddress(parsed.from).join(', ') : undefined;
	const to = formatAddressList(parsed.to);
	const cc = formatAddressList(parsed.cc);

	if (from) {
		result.from = from;
		result.fromCharset = 'utf-8';
	}
	if (to) {
		result.to = to;
		result.toCharset = 'utf-8';
	}
	if (cc) {
		result.cc = cc;
		result.ccCharset = 'utf-8';
	}
	const normalizedSubject = parsed.subject?.includes('\uFFFD') && decodedHeaders.subject
		? decodedHeaders.subject
		: parsed.subject ?? decodedHeaders.subject;
	if (normalizedSubject) {
		result.subject = normalizedSubject;
		result.subjectCharset = 'utf-8';
	}

	const declaredCharset = normalizeCharset(parseCharset(rawHeaders['content-type'])) ?? 'utf-8';
	const contentType = (rawHeaders['content-type'] || '').toLowerCase();
	const contentTransferEncoding = (rawHeaders['content-transfer-encoding'] || '').toLowerCase();
	const rawBody = extractRawBody(raw);

	const fallbackDecision = shouldUseMultipartCompat(contentType, rawHeaders['content-type'] || '', rawBody, parsed);
	if (fallbackDecision.shouldFallback) {
		const compatBody = parseMultipartCompat(rawBody, rawHeaders['content-type'] || '');
		if (compatBody.text) {
			result.text = stripSingleTrailingNewline(compatBody.text);
			result.textCharset = normalizeCharset(compatBody.textCharset) ?? declaredCharset;
		}
		if (compatBody.html) {
			result.html = stripSingleTrailingNewline(compatBody.html);
			result.htmlCharset = normalizeCharset(compatBody.htmlCharset) ?? declaredCharset;
		}
		return result;
	}

	if (contentType.includes('multipart/')) {
		if (parsed.text) {
			result.text = stripSingleTrailingNewline(parsed.text);
			result.textCharset = declaredCharset;
		}
		if (parsed.html) {
			result.html = stripSingleTrailingNewline(parsed.html);
			result.htmlCharset = declaredCharset;
		}
		return result;
	}

	if (parsed.text) {
		const normalizedText = stripSingleTrailingNewline(parsed.text);
		if (normalizedText.includes('\uFFFD')) {
			const fallback = decodeBody(rawBody, contentTransferEncoding, declaredCharset);
			result.text = stripSingleTrailingNewline(fallback.text);
			result.textCharset = normalizeCharset(fallback.charset) ?? declaredCharset;
		} else {
			result.text = normalizedText;
			result.textCharset = declaredCharset;
		}
	}
	if (parsed.html) {
		result.html = stripSingleTrailingNewline(parsed.html);
		result.htmlCharset = declaredCharset;
	}

	return result;
}
