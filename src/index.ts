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

function scoreDecodedHeaderText(text: string): number {
	if (!text) return 0;
	const replacement = (text.match(/\uFFFD/g) || []).length;
	const controls = (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g) || []).length;
	const halfwidthPunc = (text.match(/[\uFF61-\uFF65]/g) || []).length;
	const halfwidthRun = (text.match(/[\uFF61-\uFF65]{2,}/g) || []).length;
	return replacement * 100 + controls * 20 + halfwidthPunc * 8 + halfwidthRun * 30;
}

function decodeBytesWithFallback(bytes: Uint8Array, declaredCharset?: string): { text: string; charset?: string } {
	const candidates: string[] = [];
	const addCandidate = (charset: string | undefined) => {
		const cs = normalizeCharset(charset);
		if (!cs) return;
		if (!candidates.includes(cs)) candidates.push(cs);
	};

	addCandidate(declaredCharset);
	addCandidate('utf-8');
	addCandidate('windows-31j');
	addCandidate('shift_jis');
	addCandidate('euc-jp');
	addCandidate('iso-2022-jp');
	addCandidate('iso-8859-1');

	let bestText = decodeBytes(bytes, normalizeCharset(declaredCharset));
	let bestScore = scoreDecodedHeaderText(bestText);
	let bestCharset = normalizeCharset(declaredCharset);

	for (const cs of candidates) {
		try {
			const decoded = new TextDecoder(cs).decode(bytes);
			const score = scoreDecodedHeaderText(decoded);
			if (score < bestScore) {
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
	const candidates = ['utf-8', 'shift_jis', 'windows-31j', 'euc-jp', 'iso-2022-jp', 'iso-8859-1'];
	for (const cs of candidates) {
		try {
			const decoded = new TextDecoder(cs).decode(bytes);
			if (!decoded.includes('\uFFFD')) return cs;
		} catch (e) {
			// TextDecoder may not support this encoding in the environment; ignore
			continue;
		}
	}
	return undefined;
}

// Guess charset for header values; prefers raw header text (which may include encoded-words)
function guessHeaderCharset(values: Array<string | undefined>): string | undefined {
	for (const v of values) {
		if (!v) continue;
		// Try to find RFC2047 encoded-words and guess from their payload bytes
		const re = /=\?([^?]+)\?([bqBQ])\?([^?]+)\?=/g;
		let m: RegExpExecArray | null;
		let found = false;
		while ((m = re.exec(v)) !== null) {
			found = true;
			const declared = normalizeCharset(m[1] || '');
			if (declared) return declared;
			const enc = (m[2] || '').toLowerCase();
			const txt = m[3] || '';
			try {
				const bytes = enc === 'b' ? base64ToUint8Array(txt) : quotedPrintableToUint8Array(txt.replace(/_/g, ' '));
				const g = guessCharset(bytes);
				if (g) return g;
			} catch (e) { /* ignore */ }
		}
		// If no encoded-word found, try guessing from UTF-8 encoded header string
		if (!found) {
			try {
				const encBytes = new TextEncoder().encode(v);
				const g = guessCharset(encBytes);
				if (g) return g;
			} catch (e) { /* ignore */ }
		}
	}
	return undefined;
}

function decodeHeaderValue(val: string): string {
	if (!val) return val;
	// RFC2047: whitespace between adjacent encoded-words should be ignored
	const normalized = val.replace(/(\?=)\s+(=\?)/g, '$1$2');
	// decode RFC2047 encoded-words: =?charset?B?...?= or =?charset?Q?...?=
	return normalized.replace(/=\?([^?]+)\?([bqBQ])\?([^?]+)\?=/g, (_m, cs, enc, txt) => {
		const csNorm = normalizeCharset(cs || 'utf-8');
		if ((enc || '').toLowerCase() === 'b') {
			try {
				const bytes = base64ToUint8Array(txt);
				return decodeBytesWithFallback(bytes, csNorm).text;
			} catch (e) { return txt; }
		} else {
			const qp = txt.replace(/_/g, ' ');
			try {
				const bytes = quotedPrintableToUint8Array(qp);
				return decodeBytesWithFallback(bytes, csNorm).text;
			} catch (e) { return qp; }
		}
	});
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

	const indexOfSeq = (seq: string) => buffer.indexOf(seq);

	// Read headers
	while (indexOfSeq('\r\n\r\n') === -1 && indexOfSeq('\n\n') === -1) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		if (buffer.length > 1024 * 1024) break; // protect
	}

	let sep = '\r\n\r\n';
	let idx = buffer.indexOf(sep);
	if (idx === -1) { sep = '\n\n'; idx = buffer.indexOf(sep); }
	const rawHeaders = idx !== -1 ? buffer.slice(0, idx) : buffer;
	buffer = idx !== -1 ? buffer.slice(idx + sep.length) : '';

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
        result.fromCharset = guessHeaderCharset([headers?.['from'], decodedHeaders['from']]);
    }
	if (decodedHeaders['to']) {
        result.to = decodedHeaders['to'];
        result.toCharset = guessHeaderCharset([headers?.['to'], decodedHeaders['to']]);
    }
    if (decodedHeaders['cc']) {
        result.cc = decodedHeaders['cc'];
        result.ccCharset = guessHeaderCharset([headers?.['cc'], decodedHeaders['cc']]);
    }
	if (decodedHeaders['subject']) {
        result.subject = decodedHeaders['subject'];
        result.subjectCharset = guessHeaderCharset([headers?.['subject'], decodedHeaders['subject']]);
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
				const usedCharset = headerCharset ?? guessCharset(contentBytes);
				const content = decodeBytes(contentBytes, usedCharset);
				if (isText) {
                    result.textCharset = usedCharset;
                    result.text = (result.text ? result.text + '\n' : '') + content;
                }
				if (isHtml) {
                    result.htmlCharset = usedCharset;
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
		const usedBodyCharset = headerCharset ?? guessCharset(bodyBytes);
		const body = decodeBytes(bodyBytes, usedBodyCharset);
		if (/text\/html/i.test(contentType)) {
            result.htmlCharset = usedBodyCharset;
            result.html = body;
        } else {
            result.textCharset = usedBodyCharset;
            result.text = body;
        } 
	}

	return result;
}

export default {
	async email(message, env, ctx) {
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
		headerCharsets['from'] = parsed.fromCharset || '';

        // To
		form.append('to', parsed.to ?? message.to ?? '');
		headerCharsets['to'] = parsed.toCharset || '';

		// Subject
		form.append('subject', parsed.subject ?? '');
		headerCharsets['subject'] = parsed.subjectCharset || '';

        // Cc
		if (parsed.cc) {
			form.append('cc', parsed.cc);
			headerCharsets['cc'] = parsed.ccCharset || '';
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
} satisfies ExportedHandler<Env>;
