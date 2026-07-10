const PREVIEW_TOKEN_MAX_LENGTH = 512;
const BEARER_PREFIX_PATTERN = /^Bearer\s+(.+)$/i;

export function extractBearerToken(request: Request): string | undefined {
	const header = request.headers.get('Authorization');
	if (!header) return undefined;

	const match = BEARER_PREFIX_PATTERN.exec(header);
	if (!match) return undefined;

	const token = match[1];
	if (token.length > PREVIEW_TOKEN_MAX_LENGTH) return undefined;

	return token;
}

async function sha256(value: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
}

export async function verifyPreviewToken(request: Request, expected: string | undefined): Promise<boolean> {
	if (!expected) return false;

	const received = extractBearerToken(request);
	if (!received) return false;

	const [receivedDigest, expectedDigest] = await Promise.all([sha256(received), sha256(expected)]);
	return crypto.subtle.timingSafeEqual(receivedDigest, expectedDigest);
}
