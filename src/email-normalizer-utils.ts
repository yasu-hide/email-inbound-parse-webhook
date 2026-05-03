export function decodeBytes(bytes: Uint8Array, charset?: string): string {
	try {
		return new TextDecoder(charset || 'utf-8').decode(bytes);
	} catch (e) {
		try {
			return new TextDecoder('utf-8').decode(bytes);
		} catch (e2) {
			return String.fromCharCode(...Array.from(bytes));
		}
	}
}

export function normalizeCharset(charset: string | undefined): string | undefined {
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

export function scoreDecodedText(text: string): number {
	if (!text) return 0;
	const replacement = (text.match(/\uFFFD/g) || []).length;
	const controls = (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g) || []).length;
	const halfwidthPunc = (text.match(/[\uFF61-\uFF65]/g) || []).length;
	const halfwidthRun = (text.match(/[\uFF61-\uFF65]{2,}/g) || []).length;
	return replacement * 100 + controls * 20 + halfwidthPunc * 8 + halfwidthRun * 30;
}

export function isAsciiOnly(bytes: Uint8Array): boolean {
	for (const b of bytes) {
		if (b > 0x7f) return false;
	}
	return true;
}

export function hasIso2022JpEscape(bytes: Uint8Array): boolean {
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] === 0x1b) return true;
	}
	return false;
}

export function isValidUtf8(bytes: Uint8Array): boolean {
	try {
		new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
		return true;
	} catch (e) {
		return false;
	}
}

export function binaryStringToUint8Array(value: string): Uint8Array {
	const bytes = new Uint8Array(value.length);
	for (let i = 0; i < value.length; i++) {
		bytes[i] = value.charCodeAt(i) & 0xff;
	}
	return bytes;
}