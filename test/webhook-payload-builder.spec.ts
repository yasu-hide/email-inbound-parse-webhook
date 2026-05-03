import { describe, expect, it } from 'vitest';
import type { ParsedResult } from '../src/email-parser';
import {
	buildWebhookFormData,
	buildWebhookPayload,
	payloadToFormData,
} from '../src/webhook-payload-builder';

function makeParsed(partial: Partial<ParsedResult>): ParsedResult {
	return {
		headers: {},
		...partial,
	};
}

function formToObject(form: FormData): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of form.entries()) {
		out[key] = String(value);
	}
	return out;
}

describe('webhook-payload-builder', () => {
	it('builds payload with envelope fallback and required charset fields', () => {
		const payload = buildWebhookPayload(
			makeParsed({ subject: 'hello' }),
			{ from: 'fallback-from@example.com', to: 'fallback-to@example.com' },
		);

		expect(payload).toEqual({
			from: 'fallback-from@example.com',
			to: 'fallback-to@example.com',
			subject: 'hello',
			charsets: {
				from: 'utf-8',
				to: 'utf-8',
				subject: 'utf-8',
			},
		});
	});

	it('keeps required keys and omits optional fields when source values are absent', () => {
		const payload = buildWebhookPayload(
			makeParsed({}),
			{},
		);
		const { form, headerCharsets } = payloadToFormData(payload);
		const body = formToObject(form);

		expect(body).toEqual({
			from: '',
			to: '',
			subject: '',
			charsets: JSON.stringify({ from: '', to: '', subject: '' }),
		});
		expect(headerCharsets).toEqual({ from: '', to: '', subject: '' });
		expect(body.cc).toBeUndefined();
		expect(body.text).toBeUndefined();
		expect(body.html).toBeUndefined();
	});

	it('adds optional fields and charset metadata only when values exist', () => {
		const payload = buildWebhookPayload(
			makeParsed({
				from: 'Parsed From <from@example.com>',
				to: 'Parsed To <to@example.com>',
				subject: 'subject',
				cc: 'cc@example.com',
				text: 'plain body',
				textCharset: 'iso-2022-jp',
				html: '<p>html</p>',
				htmlCharset: 'utf-8',
			}),
			{ from: 'envelope-from@example.com', to: 'envelope-to@example.com' },
		);
		const { form, headerCharsets } = payloadToFormData(payload);
		const body = formToObject(form);

		expect(body.from).toBe('Parsed From <from@example.com>');
		expect(body.to).toBe('Parsed To <to@example.com>');
		expect(body.subject).toBe('subject');
		expect(body.cc).toBe('cc@example.com');
		expect(body.text).toBe('plain body');
		expect(body.html).toBe('<p>html</p>');
		expect(headerCharsets).toEqual({
			from: 'utf-8',
			to: 'utf-8',
			subject: 'utf-8',
			cc: 'utf-8',
			text: 'iso-2022-jp',
			html: 'utf-8',
		});
		expect(JSON.parse(body.charsets)).toEqual(headerCharsets);
	});

	it('omits optional payload fields when values are empty strings', () => {
		const payload = buildWebhookPayload(
			makeParsed({
				from: 'Parsed From <from@example.com>',
				to: 'Parsed To <to@example.com>',
				subject: '',
				cc: '',
				text: '',
				html: '',
			}),
			{},
		);
		const { form, headerCharsets } = payloadToFormData(payload);
		const body = formToObject(form);

		expect(body.from).toBe('Parsed From <from@example.com>');
		expect(body.to).toBe('Parsed To <to@example.com>');
		expect(body.subject).toBe('');
		expect(body.cc).toBeUndefined();
		expect(body.text).toBeUndefined();
		expect(body.html).toBeUndefined();
		expect(headerCharsets).toEqual({
			from: 'utf-8',
			to: 'utf-8',
			subject: '',
		});
	});

	it('keeps wrapper compatibility with the new two-step builder across matrix cases', () => {
		const cases: Array<{ parsed: Partial<ParsedResult>; message: { from?: string; to?: string } }> = [
			{
				parsed: { from: 'Parsed <from@example.com>', to: 'To <to@example.com>', subject: 'A' },
				message: { from: 'EnvFrom', to: 'EnvTo' },
			},
			{
				parsed: { subject: 'B', text: 'body', textCharset: 'iso-2022-jp' },
				message: { from: 'EnvFrom', to: 'EnvTo' },
			},
			{
				parsed: { cc: 'cc@example.com', html: '<h1>x</h1>', htmlCharset: 'utf-8' },
				message: {},
			},
			{
				parsed: { subject: '', text: '', html: '' },
				message: { from: 'EnvFrom', to: undefined },
			},
		];

		for (const c of cases) {
			const parsed = makeParsed(c.parsed);
			const oldPath = buildWebhookFormData(parsed, c.message);
			const newPath = payloadToFormData(buildWebhookPayload(parsed, c.message));

			expect(formToObject(oldPath.form)).toEqual(formToObject(newPath.form));
			expect(oldPath.headerCharsets).toEqual(newPath.headerCharsets);
		}
	});
});
