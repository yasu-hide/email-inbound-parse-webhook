import { describe, expect, it } from 'vitest';
import {
	WEBHOOK_SIGNATURE_HEADER,
	WEBHOOK_TIMESTAMP_HEADER,
	WebhookSignatureError,
	buildSignedPayload,
	createWebhookSignatureHeaders,
	p1363ToDer,
} from '../src/webhook-signature';

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function arrayBufferToPem(label: string, buffer: ArrayBuffer): string {
	const base64 = bytesToBase64(new Uint8Array(buffer));
	const lines = base64.match(/.{1,64}/g)?.join('\n') ?? '';
	return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
}

function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function derToP1363(der: Uint8Array): Uint8Array {
	if (der[0] !== 0x30) throw new Error('Expected DER sequence');
	let offset = 2;

	const readInteger = () => {
		if (der[offset++] !== 0x02) throw new Error('Expected DER integer');
		const length = der[offset++];
		let value = der.slice(offset, offset + length);
		offset += length;
		while (value.length > 1 && value[0] === 0) {
			value = value.slice(1);
		}
		if (value.length > 32) throw new Error('Integer does not fit P-256');

		const padded = new Uint8Array(32);
		padded.set(value, 32 - value.length);
		return padded;
	};

	const signature = new Uint8Array(64);
	signature.set(readInteger(), 0);
	signature.set(readInteger(), 32);
	return signature;
}

async function createTestKeyPair() {
	const pair = await crypto.subtle.generateKey(
		{ name: 'ECDSA', namedCurve: 'P-256' },
		true,
		['sign', 'verify'],
	) as CryptoKeyPair;
	const [privateKey, publicKey] = await Promise.all([
		crypto.subtle.exportKey('pkcs8', pair.privateKey) as Promise<ArrayBuffer>,
		crypto.subtle.exportKey('spki', pair.publicKey) as Promise<ArrayBuffer>,
	]);

	return {
		privatePem: arrayBufferToPem('PRIVATE KEY', privateKey),
		publicKey: await crypto.subtle.importKey(
			'spki',
			publicKey,
			{ name: 'ECDSA', namedCurve: 'P-256' },
			false,
			['verify'],
		),
	};
}

describe('webhook signature', () => {
	it('signs timestamp plus exact raw body using a P-256 PKCS#8 PEM key', async () => {
		const { privatePem, publicKey } = await createTestKeyPair();
		const rawBody = bytesToArrayBuffer(new TextEncoder().encode('multipart body bytes'));
		const headers = await createWebhookSignatureHeaders({
			privateKey: privatePem,
			rawBody,
			nowMs: 1_700_000_000_000,
		});

		expect(headers[WEBHOOK_TIMESTAMP_HEADER]).toBe('1700000000');
		const signature = derToP1363(base64ToBytes(headers[WEBHOOK_SIGNATURE_HEADER]));
		await expect(crypto.subtle.verify(
			{ name: 'ECDSA', hash: 'SHA-256' },
			publicKey,
			signature,
			buildSignedPayload(headers[WEBHOOK_TIMESTAMP_HEADER], rawBody),
		)).resolves.toBe(true);
	});

	it('accepts escaped newlines in the PEM secret', async () => {
		const { privatePem } = await createTestKeyPair();
		const rawBody = bytesToArrayBuffer(new TextEncoder().encode('body'));
		const headers = await createWebhookSignatureHeaders({
			privateKey: privatePem.replace(/\n/g, '\\n'),
			rawBody,
			nowMs: 1_700_000_000_000,
		});

		expect(headers[WEBHOOK_SIGNATURE_HEADER]).toEqual(expect.any(String));
	});

	it('fails verification when raw body or timestamp changes', async () => {
		const { privatePem, publicKey } = await createTestKeyPair();
		const rawBody = bytesToArrayBuffer(new TextEncoder().encode('original'));
		const modifiedBody = bytesToArrayBuffer(new TextEncoder().encode('modified'));
		const headers = await createWebhookSignatureHeaders({
			privateKey: privatePem,
			rawBody,
			nowMs: 1_700_000_000_000,
		});
		const signature = derToP1363(base64ToBytes(headers[WEBHOOK_SIGNATURE_HEADER]));

		await expect(crypto.subtle.verify(
			{ name: 'ECDSA', hash: 'SHA-256' },
			publicKey,
			signature,
			buildSignedPayload(headers[WEBHOOK_TIMESTAMP_HEADER], modifiedBody),
		)).resolves.toBe(false);
		await expect(crypto.subtle.verify(
			{ name: 'ECDSA', hash: 'SHA-256' },
			publicKey,
			signature,
			buildSignedPayload('1700000001', rawBody),
		)).resolves.toBe(false);
	});

	it('rejects missing and invalid private keys', async () => {
		const rawBody = bytesToArrayBuffer(new TextEncoder().encode('body'));

		await expect(createWebhookSignatureHeaders({ privateKey: '', rawBody }))
			.rejects.toBeInstanceOf(WebhookSignatureError);
		await expect(createWebhookSignatureHeaders({ privateKey: 'not-a-pem', rawBody }))
			.rejects.toBeInstanceOf(WebhookSignatureError);
	});

	it('encodes minimal P1363 signature integers as DER', () => {
		const signature = new Uint8Array(64);
		signature[31] = 0x01;
		signature[63] = 0x02;

		expect(Array.from(p1363ToDer(bytesToArrayBuffer(signature)))).toEqual([
			0x30, 0x06,
			0x02, 0x01, 0x01,
			0x02, 0x01, 0x02,
		]);
	});

	it('adds a DER sign byte when an integer high bit is set', () => {
		const signature = new Uint8Array(64);
		signature[0] = 0x80;
		signature[32] = 0x7f;
		const der = p1363ToDer(bytesToArrayBuffer(signature));

		expect(der[0]).toBe(0x30);
		expect(der[1]).toBe(0x45);
		expect(der[2]).toBe(0x02);
		expect(der[3]).toBe(0x21);
		expect(der[4]).toBe(0x00);
		expect(der[5]).toBe(0x80);
		expect(der[37]).toBe(0x02);
		expect(der[38]).toBe(0x20);
		expect(der[39]).toBe(0x7f);
	});

	it('trims leading zeroes before DER integer sign-byte handling', () => {
		const signature = new Uint8Array(64);
		signature[0] = 0x00;
		signature[1] = 0x80;
		signature[63] = 0x03;
		const der = p1363ToDer(bytesToArrayBuffer(signature));

		expect(der[2]).toBe(0x02);
		expect(der[3]).toBe(0x20);
		expect(der[4]).toBe(0x00);
		expect(der[5]).toBe(0x80);
		expect(der[36]).toBe(0x02);
		expect(der[37]).toBe(0x01);
		expect(der[38]).toBe(0x03);
	});
});
