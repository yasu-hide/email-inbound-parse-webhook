import { describe, expect, it } from 'vitest';
import { extractBearerToken, verifyPreviewToken } from '../src/preview-auth';

function requestWithAuth(header?: string): Request {
	const headers = new Headers();
	if (header !== undefined) headers.set('Authorization', header);
	return new Request('https://example.test/internal/payload-preview', { headers });
}

describe('extractBearerToken', () => {
	it('returns undefined when the header is missing', () => {
		expect(extractBearerToken(requestWithAuth())).toBeUndefined();
	});

	it('extracts the token from a Bearer header', () => {
		expect(extractBearerToken(requestWithAuth('Bearer secret-token'))).toBe('secret-token');
	});

	it('matches the Bearer scheme case-insensitively', () => {
		expect(extractBearerToken(requestWithAuth('bearer secret-token'))).toBe('secret-token');
	});

	it('returns undefined for a non-Bearer scheme', () => {
		expect(extractBearerToken(requestWithAuth('Basic xxx'))).toBeUndefined();
	});

	it('returns undefined when the token exceeds the length limit', () => {
		const oversized = 'a'.repeat(513);
		expect(extractBearerToken(requestWithAuth(`Bearer ${oversized}`))).toBeUndefined();
	});

	it('accepts a token at the length limit', () => {
		const maxLength = 'a'.repeat(512);
		expect(extractBearerToken(requestWithAuth(`Bearer ${maxLength}`))).toBe(maxLength);
	});
});

describe('verifyPreviewToken', () => {
	it('returns false when the expected token is not configured', async () => {
		await expect(verifyPreviewToken(requestWithAuth('Bearer anything'), undefined)).resolves.toBe(false);
	});

	it('returns false when the request has no token', async () => {
		await expect(verifyPreviewToken(requestWithAuth(), 'expected-token')).resolves.toBe(false);
	});

	it('returns false when tokens of different lengths do not match', async () => {
		await expect(verifyPreviewToken(requestWithAuth('Bearer short'), 'a-much-longer-expected-token')).resolves.toBe(false);
	});

	it('returns false when tokens of equal length do not match', async () => {
		await expect(verifyPreviewToken(requestWithAuth('Bearer aaaaaaaa'), 'bbbbbbbb')).resolves.toBe(false);
	});

	it('returns true when the token matches exactly', async () => {
		await expect(verifyPreviewToken(requestWithAuth('Bearer expected-token'), 'expected-token')).resolves.toBe(true);
	});
});
