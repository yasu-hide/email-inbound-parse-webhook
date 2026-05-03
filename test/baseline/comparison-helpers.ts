import type { ParsedResult } from '../../src/email-parser';
import type { WebhookPayload } from '../../src/webhook-payload-builder';

export type DiffCategory = 'payload_missing' | 'mis_mapping' | 'mojibake' | 'headers_mismatch' | 'non_critical';

export type DiffItem = {
	field: string;
	category: DiffCategory;
	critical: boolean;
	legacyValue: string;
	currentValue: string;
	note?: string;
};

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function normalizeAddress(value: string): string {
	return normalizeWhitespace(value.replace(/"/g, '').replace(/\s*,\s*/g, ', '));
}

function normalizeBody(value: string): string {
	return value.replace(/\r\n/g, '\n').replace(/\n$/, '');
}

function normalizeHeaderValue(value: string): string {
	return normalizeWhitespace(value.replace(/\r?\n[\t ]+/g, ' '));
}

function normalizeHeaderMap(headers: Record<string, string> | undefined): Record<string, string> {
	if (!headers) return {};
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers)) {
		out[k.toLowerCase()] = normalizeHeaderValue(v);
	}
	return out;
}

function hasReplacement(value: string): boolean {
	return value.includes('\uFFFD');
}

function compareStringField(
	diffs: DiffItem[],
	field: string,
	legacyValue: string | undefined,
	currentValue: string | undefined,
	normalize: (value: string) => string,
): void {
	const legacy = legacyValue ?? '';
	const current = currentValue ?? '';
	if (legacy === current) return;
	if (normalize(legacy) === normalize(current)) {
		diffs.push({
			field,
			category: 'non_critical',
			critical: false,
			legacyValue: legacy,
			currentValue: current,
			note: 'normalized_match',
		});
		return;
	}

	if (legacy && !current) {
		diffs.push({
			field,
			category: 'payload_missing',
			critical: true,
			legacyValue: legacy,
			currentValue: current,
		});
		return;
	}

	if (hasReplacement(current) || hasReplacement(legacy)) {
		diffs.push({
			field,
			category: 'mojibake',
			critical: true,
			legacyValue: legacy,
			currentValue: current,
		});
		return;
	}

	diffs.push({
		field,
		category: 'mis_mapping',
		critical: true,
		legacyValue: legacy,
		currentValue: current,
	});
}

function compareHeaderField(
	diffs: DiffItem[],
	field: 'headers' | 'rawHeaders',
	legacyHeaders: Record<string, string> | undefined,
	currentHeaders: Record<string, string> | undefined,
): void {
	const legacy = normalizeHeaderMap(legacyHeaders);
	const current = normalizeHeaderMap(currentHeaders);
	const keys = new Set([...Object.keys(legacy), ...Object.keys(current)]);
	for (const key of keys) {
		const left = legacy[key] ?? '';
		const right = current[key] ?? '';
		if (left === right) continue;
		diffs.push({
			field: `${field}.${key}`,
			category: 'headers_mismatch',
			critical: true,
			legacyValue: left,
			currentValue: right,
		});
	}
}

function comparePayloads(diffs: DiffItem[], legacy: WebhookPayload, current: WebhookPayload): void {
	const requiredKeys: Array<keyof WebhookPayload> = ['from', 'to', 'subject'];
	for (const key of requiredKeys) {
		if (legacy[key] && !current[key]) {
			diffs.push({
				field: `payload.${key}`,
				category: 'payload_missing',
				critical: true,
				legacyValue: String(legacy[key] ?? ''),
				currentValue: String(current[key] ?? ''),
			});
		}
	}

	if (legacy.text && current.html && legacy.text === current.html) {
		diffs.push({
			field: 'payload.text',
			category: 'mis_mapping',
			critical: true,
			legacyValue: legacy.text,
			currentValue: current.text ?? '',
			note: 'text_html_swapped',
		});
	}

	if (legacy.html && current.text && legacy.html === current.text) {
		diffs.push({
			field: 'payload.html',
			category: 'mis_mapping',
			critical: true,
			legacyValue: legacy.html,
			currentValue: current.html ?? '',
			note: 'html_text_swapped',
		});
	}
}

export function compareParsedAndPayload(
	legacyParsed: ParsedResult,
	currentParsed: ParsedResult,
	legacyPayload: WebhookPayload,
	currentPayload: WebhookPayload,
): DiffItem[] {
	const diffs: DiffItem[] = [];

	compareStringField(diffs, 'from', legacyParsed.from, currentParsed.from, normalizeAddress);
	compareStringField(diffs, 'to', legacyParsed.to, currentParsed.to, normalizeAddress);
	compareStringField(diffs, 'cc', legacyParsed.cc, currentParsed.cc, normalizeAddress);
	compareStringField(diffs, 'subject', legacyParsed.subject, currentParsed.subject, normalizeWhitespace);
	compareStringField(diffs, 'text', legacyParsed.text, currentParsed.text, normalizeBody);
	compareStringField(diffs, 'html', legacyParsed.html, currentParsed.html, normalizeBody);

	compareStringField(diffs, 'fromCharset', legacyParsed.fromCharset, currentParsed.fromCharset, normalizeWhitespace);
	compareStringField(diffs, 'toCharset', legacyParsed.toCharset, currentParsed.toCharset, normalizeWhitespace);
	compareStringField(diffs, 'ccCharset', legacyParsed.ccCharset, currentParsed.ccCharset, normalizeWhitespace);
	compareStringField(diffs, 'subjectCharset', legacyParsed.subjectCharset, currentParsed.subjectCharset, normalizeWhitespace);
	compareStringField(diffs, 'textCharset', legacyParsed.textCharset, currentParsed.textCharset, normalizeWhitespace);
	compareStringField(diffs, 'htmlCharset', legacyParsed.htmlCharset, currentParsed.htmlCharset, normalizeWhitespace);

	compareHeaderField(diffs, 'headers', legacyParsed.headers, currentParsed.headers);
	compareHeaderField(diffs, 'rawHeaders', legacyParsed.rawHeaders, currentParsed.rawHeaders);
	comparePayloads(diffs, legacyPayload, currentPayload);

	return diffs;
}
