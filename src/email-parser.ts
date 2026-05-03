import {
	base64ToUint8Array,
	decodeBytesWithFallback,
	decodeHeaderValue,
	parseCharset,
	quotedPrintableToUint8Array,
} from './email-normalizer';

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
};

function concatUint8Arrays(left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
	const merged = new Uint8Array(left.length + right.length);
	merged.set(left, 0);
	merged.set(right, left.length);
	return merged;
}

function findHeaderSeparator(bytes: Uint8Array<ArrayBufferLike>): { index: number; length: number } | null {
	for (let i = 0; i <= bytes.length - 4; i++) {
		if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a && bytes[i + 2] === 0x0d && bytes[i + 3] === 0x0a) {
			return { index: i, length: 4 };
		}
	}

	for (let i = 0; i <= bytes.length - 2; i++) {
		if (bytes[i] === 0x0a && bytes[i + 1] === 0x0a) {
			return { index: i, length: 2 };
		}
	}

	return null;
}

function bytesToBinaryString(bytes: Uint8Array): string {
	let text = '';
	for (const byte of bytes) {
		text += String.fromCharCode(byte);
	}
	return text;
}

function decodeBody(raw: string, contentTransferEncoding: string, declaredCharset: string | undefined): { text: string; charset?: string } {
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

export async function parseEmailStream(stream: ReadableStream): Promise<ParsedResult> {
	const reader = stream.getReader();
	const decoder = new TextDecoder('utf-8');
	let buffer = '';
	let headerBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
	let headerSeparator = findHeaderSeparator(headerBuffer);

	while (!headerSeparator) {
		const { done, value } = await reader.read();
		if (done) break;
		headerBuffer = concatUint8Arrays(headerBuffer, new Uint8Array(value));
		headerSeparator = findHeaderSeparator(headerBuffer);
		if (headerBuffer.length > 1024 * 1024) break;
	}

	const rawHeaderBytes = headerSeparator ? headerBuffer.slice(0, headerSeparator.index) : headerBuffer;
	const initialBodyBytes = headerSeparator
		? headerBuffer.slice(headerSeparator.index + headerSeparator.length)
		: new Uint8Array(0);
	const rawHeaders = bytesToBinaryString(rawHeaderBytes);
	buffer = decoder.decode(initialBodyBytes, { stream: true });

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

	const decodedHeaders: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) decodedHeaders[k] = decodeHeaderValue(v);

	const contentType = headers['content-type'] || decodedHeaders['content-type'] || 'text/plain';
	const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);
	const boundary = boundaryMatch ? '--' + boundaryMatch[1] : null;

	const result: ParsedResult = { headers: decodedHeaders, rawHeaders: headers };
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

	if (boundary) {
		const partBoundary = boundary;
		while (buffer.indexOf(partBoundary) === -1) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
		}
		const startIdx = buffer.indexOf(partBoundary);
		if (startIdx !== -1) buffer = buffer.slice(startIdx + partBoundary.length);

		let doneReading = false;
		while (!doneReading) {
			while (buffer.indexOf('\r\n\r\n') === -1 && buffer.indexOf('\n\n') === -1) {
				const { done, value } = await reader.read();
				if (done) {
					doneReading = true;
					break;
				}
				buffer += decoder.decode(value, { stream: true });
			}
			if (doneReading) break;
			let sep2 = '\r\n\r\n';
			let idx2 = buffer.indexOf(sep2);
			if (idx2 === -1) {
				sep2 = '\n\n';
				idx2 = buffer.indexOf(sep2);
			}
			if (idx2 === -1) break;
			const partRawHeaders = buffer.slice(0, idx2);
			buffer = buffer.slice(idx2 + sep2.length);

			const partHeaders: Record<string, string> = {};
			for (const line of partRawHeaders.split(/\r?\n/)) {
				const m = line.match(/^([^:]+):\s*(.*)$/);
				if (m) {
					const k = m[1].toLowerCase();
					const v = m[2];
					partHeaders[k] = partHeaders[k] ? partHeaders[k] + ', ' + v : v;
				}
			}

			const pContentType = partHeaders['content-type'] || 'text/plain';
			const disposition = (partHeaders['content-disposition'] || '').toLowerCase();
			const cte = (partHeaders['content-transfer-encoding'] || '').toLowerCase();

			const isText = /text\/plain/i.test(pContentType);
			const isHtml = /text\/html/i.test(pContentType);
			const isAttachment = disposition.includes('attachment') || disposition.includes('filename=');

			let partContent = '';
			while (buffer.indexOf('\r\n' + partBoundary) === -1 && buffer.indexOf('\n' + partBoundary) === -1) {
				const { done, value } = await reader.read();
				if (done) {
					partContent += buffer;
					buffer = '';
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				if (!isAttachment && partContent.length > 5 * 1024 * 1024) break;
			}

			let boundaryIdx = buffer.indexOf('\r\n' + partBoundary);
			let boundaryLen = ('\r\n' + partBoundary).length;
			if (boundaryIdx === -1) {
				boundaryIdx = buffer.indexOf('\n' + partBoundary);
				boundaryLen = ('\n' + partBoundary).length;
			}
			if (boundaryIdx !== -1) {
				partContent += buffer.slice(0, boundaryIdx);
				buffer = buffer.slice(boundaryIdx + boundaryLen);
			} else {
				partContent += buffer;
				buffer = '';
			}

			if (!isAttachment && (isText || isHtml)) {
				const raw = partContent.replace(/^(\r?\n)/, '');
				const headerCharset = parseCharset(pContentType);
				const decodedContent = decodeBody(raw, cte, headerCharset);
				const content = decodedContent.text;
				if (isText) {
					result.textCharset = decodedContent.charset;
					result.text = (result.text ? result.text + '\n' : '') + content;
				}
				if (isHtml) {
					result.htmlCharset = decodedContent.charset;
					result.html = (result.html ? result.html + '\n' : '') + content;
				}
			}

			if (buffer.startsWith('--')) {
				break;
			}
		}
	} else {
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
			result.htmlCharset = decodedBody.charset;
			result.html = body;
		} else {
			result.textCharset = decodedBody.charset;
			result.text = body;
		}
	}

	return result;
}
