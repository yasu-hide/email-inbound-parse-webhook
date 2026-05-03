import { parseCharset } from '../email-normalizer';
import type { DecodedBody, ParsedResult } from './types';

type MultipartParseArgs = {
	reader: ReadableStreamDefaultReader<Uint8Array>;
	decoder: TextDecoder;
	initialBuffer: string;
	boundary: string;
	decodeBody: (raw: string, contentTransferEncoding: string, declaredCharset: string | undefined) => DecodedBody;
};

export async function parseMultipartBody(args: MultipartParseArgs): Promise<Pick<ParsedResult, 'text' | 'textCharset' | 'html' | 'htmlCharset'>> {
	const { reader, decoder, boundary, decodeBody } = args;
	let buffer = args.initialBuffer;
	const result: Pick<ParsedResult, 'text' | 'textCharset' | 'html' | 'htmlCharset'> = {};
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

	return result;
}
