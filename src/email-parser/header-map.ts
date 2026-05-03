import { decodeHeaderValue } from '../email-normalizer';
import type { ParsedResult } from './types';

export function parseRawHeaderMap(rawHeaders: string): Record<string, string> {
	const unfoldedRawHeaders = rawHeaders.replace(/\r?\n[\t ]+/g, ' ');
	const headers: Record<string, string> = {};
	for (const line of unfoldedRawHeaders.split(/\r?\n/)) {
		const m = line.match(/^([^:]+):\s*(.*)$/);
		if (m) {
			const k = m[1].toLowerCase();
			const v = m[2];
			headers[k] = headers[k] ? headers[k] + ', ' + v : v;
		}
	}
	return headers;
}

export function decodeHeaderMap(headers: Record<string, string>): Record<string, string> {
	const decodedHeaders: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) decodedHeaders[k] = decodeHeaderValue(v);
	return decodedHeaders;
}

export function extractBoundary(headers: Record<string, string>, decodedHeaders: Record<string, string>): { contentType: string; boundary: string | null } {
	const contentType = headers['content-type'] || decodedHeaders['content-type'] || 'text/plain';
	const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);
	const boundary = boundaryMatch ? '--' + boundaryMatch[1] : null;
	return { contentType, boundary };
}

export function applyEnvelopeHeaders(result: ParsedResult, decodedHeaders: Record<string, string>) {
	if (decodedHeaders['from']) {
		result.from = decodedHeaders['from'];
		result.fromCharset = 'utf-8';
	}
	if (decodedHeaders['to']) {
		result.to = decodedHeaders['to'];
		result.toCharset = 'utf-8';
	}
	if (decodedHeaders['cc']) {
		result.cc = decodedHeaders['cc'];
		result.ccCharset = 'utf-8';
	}
	if (decodedHeaders['subject']) {
		result.subject = decodedHeaders['subject'];
		result.subjectCharset = 'utf-8';
	}
}
