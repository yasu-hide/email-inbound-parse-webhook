import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEmailStream, type ParsedResult } from '../src/email-parser';
import { buildWebhookPayload, type WebhookPayload } from '../src/webhook-payload-builder';
import { g3Corpus, type RawEmailInput } from '../test/g3/corpus';

type GoldenCase =
	| { id: string; status: 'ok'; parsed: ParsedResult; payload: WebhookPayload }
	| { id: string; status: 'error'; error: string };

function toBytes(raw: RawEmailInput): Uint8Array {
	if (raw instanceof Uint8Array) return raw;
	return new TextEncoder().encode(raw);
}

function toStream(raw: RawEmailInput): ReadableStream {
	const stream = new Response(toBytes(raw)).body;
	if (!stream) throw new Error('Failed to create stream from corpus case');
	return stream;
}

async function buildGoldenCases(): Promise<GoldenCase[]> {
	const out: GoldenCase[] = [];

	for (const testCase of g3Corpus) {
		try {
			const parsed = await parseEmailStream(toStream(testCase.raw));
			const envelope = {
				from: testCase.envelope?.from ?? 'sender@example.com',
				to: testCase.envelope?.to ?? 'receiver@example.com',
			};
			const payload = buildWebhookPayload(parsed, envelope);
			out.push({
				id: testCase.id,
				status: 'ok',
				parsed,
				payload,
			});
		} catch (error) {
			out.push({
				id: testCase.id,
				status: 'error',
				error: String(error),
			});
		}
	}

	return out;
}

async function main() {
	const outputPath = path.join(process.cwd(), 'test', 'g3', 'golden.json');
	const goldenCases = await buildGoldenCases();
	await writeFile(outputPath, `${JSON.stringify(goldenCases, null, 2)}\n`, 'utf-8');
	console.log(`[g3] updated golden cases: ${goldenCases.length}`);
	console.log(`[g3] output: ${outputPath}`);
}

main().catch((error) => {
	console.error('[g3] golden update failed', error);
	process.exitCode = 1;
});
