import { decodeBody as defaultDecodeBody } from './email-parser/body-decoder';
import {
	applyEnvelopeHeaders as defaultApplyEnvelopeHeaders,
	decodeHeaderMap as defaultDecodeHeaderMap,
	extractBoundary as defaultExtractBoundary,
	parseRawHeaderMap as defaultParseRawHeaderMap,
} from './email-parser/header-map';
import { readHeaderSection as defaultReadHeaderSection } from './email-parser/header-section-reader';
import { parseMultipartBody as defaultParseMultipartBody } from './email-parser/multipart-scanner';
import { parseSinglepartBody as defaultParseSinglepartBody } from './email-parser/singlepart-reader';
import type { ParsedResult } from './email-parser/types';

export type { ParsedResult } from './email-parser/types';

export type EmailParserDependencies = {
	decodeBody: typeof defaultDecodeBody;
	readHeaderSection: typeof defaultReadHeaderSection;
	parseRawHeaderMap: typeof defaultParseRawHeaderMap;
	decodeHeaderMap: typeof defaultDecodeHeaderMap;
	extractBoundary: typeof defaultExtractBoundary;
	applyEnvelopeHeaders: typeof defaultApplyEnvelopeHeaders;
	parseMultipartBody: typeof defaultParseMultipartBody;
	parseSinglepartBody: typeof defaultParseSinglepartBody;
};

export const defaultParserDependencies: EmailParserDependencies = {
	decodeBody: defaultDecodeBody,
	readHeaderSection: defaultReadHeaderSection,
	parseRawHeaderMap: defaultParseRawHeaderMap,
	decodeHeaderMap: defaultDecodeHeaderMap,
	extractBoundary: defaultExtractBoundary,
	applyEnvelopeHeaders: defaultApplyEnvelopeHeaders,
	parseMultipartBody: defaultParseMultipartBody,
	parseSinglepartBody: defaultParseSinglepartBody,
};

export async function parseEmailStream(stream: ReadableStream, deps: Partial<EmailParserDependencies> = {}): Promise<ParsedResult> {
	const parserDeps: EmailParserDependencies = {
		...defaultParserDependencies,
		...deps,
	};

	const reader = stream.getReader();
	const decoder = new TextDecoder('utf-8');
	const { rawHeaders, initialBodyBuffer } = await parserDeps.readHeaderSection(reader, decoder);
	const headers = parserDeps.parseRawHeaderMap(rawHeaders);
	const decodedHeaders = parserDeps.decodeHeaderMap(headers);
	const { contentType, boundary } = parserDeps.extractBoundary(headers, decodedHeaders);

	const result: ParsedResult = { headers: decodedHeaders, rawHeaders: headers };
	parserDeps.applyEnvelopeHeaders(result, decodedHeaders);

	const body = boundary
		? await parserDeps.parseMultipartBody({
			reader,
			decoder,
			initialBuffer: initialBodyBuffer,
			boundary,
			decodeBody: parserDeps.decodeBody,
		})
		: await parserDeps.parseSinglepartBody({
			reader,
			decoder,
			initialBuffer: initialBodyBuffer,
			headers,
			contentType,
			decodeBody: parserDeps.decodeBody,
		});

	return { ...result, ...body };
}
