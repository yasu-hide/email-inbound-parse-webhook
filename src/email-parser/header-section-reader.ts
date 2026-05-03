type HeaderSection = {
	rawHeaders: string;
	initialBodyBuffer: string;
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

export async function readHeaderSection(reader: ReadableStreamDefaultReader<Uint8Array>, decoder: TextDecoder): Promise<HeaderSection> {
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

	return {
		rawHeaders: bytesToBinaryString(rawHeaderBytes),
		initialBodyBuffer: decoder.decode(initialBodyBytes, { stream: true }),
	};
}
