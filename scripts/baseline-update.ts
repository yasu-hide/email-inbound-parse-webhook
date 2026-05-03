import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEmailStream, type ParsedResult } from '../src/email-parser';
import { buildWebhookPayload, type WebhookPayload } from '../src/webhook-payload-builder';
import { baselineCases, type RawEmailInput } from '../test/baseline/cases';

type BaselineExpectedCase =
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

async function buildExpectedCases(): Promise<BaselineExpectedCase[]> {
	const out: BaselineExpectedCase[] = [];

	for (const testCase of baselineCases) {
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
	const outputPath = path.join(process.cwd(), 'test', 'baseline', 'expected-results.json');
	const expectedCases = await buildExpectedCases();
	await writeFile(outputPath, `${JSON.stringify(expectedCases, null, 2)}\n`, 'utf-8');
	console.log(`[baseline] updated expected results: ${expectedCases.length}`);
	console.log(`[baseline] output: ${outputPath}`);
}

main().catch((error) => {
	console.error('[baseline] expected results update failed', error);
	process.exitCode = 1;
});
