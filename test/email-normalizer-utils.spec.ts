import { describe, expect, it } from 'vitest';
import {
	binaryStringToUint8Array,
	hasIso2022JpEscape,
	isAsciiOnly,
	isValidUtf8,
	normalizeCharset,
	scoreDecodedText,
} from '../src/email-normalizer-utils';

describe('email normalizer utilities', () => {
	it('normalizes known charset aliases', () => {
		expect(normalizeCharset('Shift_JIS')).toBe('windows-31j');
		expect(normalizeCharset('utf8')).toBe('utf-8');
		expect(normalizeCharset('EUC_JP')).toBe('euc-jp');
		expect(normalizeCharset('ISO_2022_JP')).toBe('iso-2022-jp');
		expect(normalizeCharset('latin1')).toBe('latin1');
	});

	it('detects ascii-only byte arrays', () => {
		expect(isAsciiOnly(new Uint8Array([0x41, 0x42, 0x43]))).toBe(true);
		expect(isAsciiOnly(new Uint8Array([0x41, 0x80]))).toBe(false);
	});

	it('detects ISO-2022-JP escape bytes', () => {
		expect(hasIso2022JpEscape(new Uint8Array([0x41, 0x42]))).toBe(false);
		expect(hasIso2022JpEscape(new Uint8Array([0x41, 0x1b, 0x42]))).toBe(true);
	});

	it('validates utf-8 sequences', () => {
		const valid = new TextEncoder().encode('こんにちは');
		const invalid = new Uint8Array([0xc3, 0x28]);
		expect(isValidUtf8(valid)).toBe(true);
		expect(isValidUtf8(invalid)).toBe(false);
	});

	it('scores noisy text higher than clean text', () => {
		const clean = 'normal text';
		const noisy = 'bad\uFFFD\u0007\uFF61\uFF62';
		expect(scoreDecodedText(noisy)).toBeGreaterThan(scoreDecodedText(clean));
	});

	it('converts binary string to bytes', () => {
		const bytes = binaryStringToUint8Array('\u0000A\u00ff');
		expect(Array.from(bytes)).toEqual([0, 65, 255]);
	});
});
