// Simple streaming MIME parser that extracts headers, text and html parts
// Attachments are discarded while parsing to avoid buffering large data

type ParsedResult = {
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

type WorkerEnv = Env & {
	WEBHOOK_URL?: string;
	MAX_MESSAGE_SIZE?: number;
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

function binaryStringToUint8Array(value: string): Uint8Array {
	const bytes = new Uint8Array(value.length);
	for (let i = 0; i < value.length; i++) {
		bytes[i] = value.charCodeAt(i) & 0xff;
	}
	return bytes;
}


// helpers for charset-aware decoding: read charset from Content-Type header when present
function parseCharset(contentType: string | undefined): string | undefined {
	if (!contentType) return undefined;
	const m = contentType.match(/charset\s*=\s*"?([^";\s]+)"?/i);
	return m ? m[1].toLowerCase() : undefined;
}

function base64ToUint8Array(b64: string): Uint8Array {
	const bin = atob(b64.replace(/\s+/g, ''));
	const arr = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
	return arr;
}

function quotedPrintableToUint8Array(qp: string): Uint8Array {
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

function decodeBytes(bytes: Uint8Array, charset?: string): string {
	try {
		return new TextDecoder(charset || 'utf-8').decode(bytes);
	} catch (e) {
		try { return new TextDecoder('utf-8').decode(bytes); } catch (e2) { return String.fromCharCode(...Array.from(bytes)); }
	}
}

function normalizeCharset(charset: string | undefined): string | undefined {
	if (!charset) return undefined;
	const cs = charset.trim().toLowerCase();
	if (['sjis', 'shift-jis', 'shift_jis', 'ms932', 'cp932', 'x-sjis', 'x-ms-cp932', 'windows-31j'].includes(cs)) {
		return 'windows-31j';
	}
	if (['utf8', 'unicode-1-1-utf-8'].includes(cs)) return 'utf-8';
	if (['eucjp', 'euc_jp'].includes(cs)) return 'euc-jp';
	if (['iso2022jp', 'iso_2022_jp'].includes(cs)) return 'iso-2022-jp';
	return cs;
}

function scoreDecodedText(text: string): number {
	if (!text) return 0;
	const replacement = (text.match(/\uFFFD/g) || []).length;
	const controls = (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g) || []).length;
	const halfwidthPunc = (text.match(/[\uFF61-\uFF65]/g) || []).length;
	const halfwidthRun = (text.match(/[\uFF61-\uFF65]{2,}/g) || []).length;
	return replacement * 100 + controls * 20 + halfwidthPunc * 8 + halfwidthRun * 30;
}

function isAsciiOnly(bytes: Uint8Array): boolean {
	for (const b of bytes) {
		if (b > 0x7f) return false;
	}
	return true;
}

function hasIso2022JpEscape(bytes: Uint8Array): boolean {
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] === 0x1b) return true;
	}
	return false;
}

function isValidUtf8(bytes: Uint8Array): boolean {
	try {
		new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
		return true;
	} catch (e) {
		return false;
	}
}

function decodeBytesWithFallback(bytes: Uint8Array, declaredCharset?: string): { text: string; charset?: string } {
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

// Try to guess charset by attempting decodes and checking for replacement chars
function guessCharset(bytes: Uint8Array): string | undefined {
	return decodeBytesWithFallback(bytes).charset;
}

function decodeHeaderTextSegment(segment: string): string {
	if (!segment) return '';
	const bytes = binaryStringToUint8Array(segment);
	if (isAsciiOnly(bytes)) return segment;
	return decodeBytesWithFallback(bytes).text;
}

function decodeHeaderValue(rawValue: string): string {
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

// safe wrapper for message.setReject to avoid repeating try/catch
function safeSetReject(message: any, reason: string) {
	try {
		message.setReject(reason);
	} catch (err) {
		console.error('setReject failed', String(err));
	}
}

async function parseEmailStream(stream: ReadableStream): Promise<ParsedResult> {
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

	// decode header encoded-words
	const decodedHeaders: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) decodedHeaders[k] = decodeHeaderValue(v);

	const contentType = headers['content-type'] || decodedHeaders['content-type'] || 'text/plain';
	const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);
	const boundary = boundaryMatch ? ('--' + boundaryMatch[1]) : null;

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
				if (done) { doneReading = true; break; }
				buffer += decoder.decode(value, { stream: true });
			}
			if (doneReading) break;
			let sep2 = '\r\n\r\n';
			let idx2 = buffer.indexOf(sep2);
			if (idx2 === -1) { sep2 = '\n\n'; idx2 = buffer.indexOf(sep2); }
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
				if (done) { partContent += buffer; buffer = ''; break; }
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
				partContent += buffer; buffer = '';
			}

			if (!isAttachment && (isText || isHtml)) {
				let contentBytes: Uint8Array;
				const raw = partContent.replace(/^(\r?\n)/, '');
				const headerCharset = parseCharset(pContentType);
				if (cte === 'base64') {
					try { contentBytes = base64ToUint8Array(raw); } catch (e) { contentBytes = new TextEncoder().encode(raw); }
				} else if (cte === 'quoted-printable') {
					try { contentBytes = quotedPrintableToUint8Array(raw); } catch (e) { contentBytes = new TextEncoder().encode(raw); }
				} else {
					contentBytes = new TextEncoder().encode(raw);
				}
				const decodedContent = decodeBytesWithFallback(contentBytes, headerCharset);
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

			if (buffer.startsWith('--')) { break; }
		}
	} else {
		// not multipart: buffer already contains start of body
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			if (buffer.length > 10 * 1024 * 1024) break;
		}
		const cte = (headers['content-transfer-encoding'] || '').toLowerCase();
		let bodyBytes: Uint8Array;
		const headerCharset = parseCharset(contentType);
		if (cte === 'base64') {
			try { bodyBytes = base64ToUint8Array(buffer); } catch (e) { bodyBytes = new TextEncoder().encode(buffer); }
		} else if (cte === 'quoted-printable') {
			try { bodyBytes = quotedPrintableToUint8Array(buffer); } catch (e) { bodyBytes = new TextEncoder().encode(buffer); }
		} else {
			bodyBytes = new TextEncoder().encode(buffer);
		}
		const decodedBody = decodeBytesWithFallback(bodyBytes, headerCharset);
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

export default {
	async email(message, env: WorkerEnv, ctx) {
		console.info('email.received', { from: message.from, to: message.to, rawSize: (message as any).rawSize });

		if (!env.WEBHOOK_URL) {
			console.error('email.rejected.no_webhook', { from: message.from, to: message.to });
			safeSetReject(message, 'WEBHOOK_URL not configured');
			return;
		}

		// If runtime provides rawSize, reject overly large messages early
		const MAX = typeof env.MAX_MESSAGE_SIZE === 'number' ? env.MAX_MESSAGE_SIZE : 10 * 1024 * 1024; // 10MB default
		// message.rawSize may not be present in all runtimes; guard
		// @ts-ignore
		if (typeof message.rawSize === 'number' && message.rawSize > MAX) {
			console.warn('email.rejected.too_large', { size: message.rawSize, max: MAX });
			safeSetReject(message, 'Message too large');
			return;
		}

		let parsed: ParsedResult;
		try {
			parsed = await parseEmailStream(message.raw as ReadableStream);
		} catch (e) {
			console.error('email.parse_error', { error: String(e) });
			safeSetReject(message, 'Parsing error');
			return;
		}

		const form = new FormData();

		// Build charsets based on parsed presence; fall back to parsed.* or message.* when raw header missing
		const headerCharsets: Record<string, string> = {};
		// From
		form.append('from', parsed.from ?? message.from ?? '');
		headerCharsets['from'] = parsed.from ?? message.from ? 'utf-8' : '';

		// To
		form.append('to', parsed.to ?? message.to ?? '');
		headerCharsets['to'] = parsed.to ?? message.to ? 'utf-8' : '';

		// Subject
		form.append('subject', parsed.subject ?? '');
		headerCharsets['subject'] = parsed.subject ? 'utf-8' : '';

		// Cc
		if (parsed.cc) {
			form.append('cc', parsed.cc);
			headerCharsets['cc'] = 'utf-8';
		}

		// Text
		if (parsed.text) {
			form.append('text', parsed.text);
			headerCharsets['text'] = parsed.textCharset || '';
		}

		// HTML
		if (parsed.html) {
			form.append('html', parsed.html);
			headerCharsets['html'] = parsed.htmlCharset || '';
		}

		form.append('charsets', JSON.stringify(headerCharsets));

		console.info('email.parsed', {
			from: parsed.from ?? message.from,
			to: parsed.to ?? message.to,
			subject: parsed.subject,
			charsets: headerCharsets
		});

		try {
			const res = await fetch(env.WEBHOOK_URL, { method: 'POST', body: form });
			if (res.ok) {
				console.info('webhook.post_success', { status: res.status });
			} else {
				console.error('webhook.post_failure', { status: res.status });
			}
		} catch (e) {
			console.error('webhook.post_error', { error: String(e) });
		}
	},
} satisfies ExportedHandler<WorkerEnv>;
