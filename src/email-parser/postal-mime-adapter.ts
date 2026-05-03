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
	const canFallbackDecodeText = !contentType.includes('multipart/');
	const rawBody = canFallbackDecodeText ? extractRawBody(raw) : '';
	if (parsed.text) {
		const normalizedText = stripSingleTrailingNewline(parsed.text);
		if (normalizedText.includes('\uFFFD') && canFallbackDecodeText) {
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
