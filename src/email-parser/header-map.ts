import { decodeHeaderValue } from '../email-normalizer';

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
