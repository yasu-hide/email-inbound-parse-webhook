import { defaultParserDependencies, parseEmailStream, type ParsedResult } from '../../src/email-parser';
import { buildWebhookPayload } from '../../src/webhook-payload-builder';
import { compareParsedAndPayload, type DiffItem } from './compare-helpers';
import { g3Corpus, type RawEmailInput } from './corpus';

export type ParseResult =
	| { ok: true; parsed: ParsedResult }
	| { ok: false; error: string };

export type CaseReport = {
	id: string;
	group: 'normal' | 'error';
	description: string;
	status: 'match' | 'critical_diff' | 'error';
	criticalDiffCount: number;
	diffs: DiffItem[];
	error?: {
		legacy?: string;
		current?: string;
	};
};

export type G3CompareReport = {
	generatedAt: string;
	total: number;
	normalCount: number;
	errorCount: number;
	matchedCases: number;
	matchRate: number;
	criticalCaseCount: number;
	criticalDiffCount: number;
	gate: {
		thresholdMatchRate: number;
		requireZeroCriticalDiff: boolean;
		pass: boolean;
	};
	cases: CaseReport[];
};

function toBytes(raw: RawEmailInput): Uint8Array {
	if (raw instanceof Uint8Array) return raw;
	return new TextEncoder().encode(raw);
}

function toStream(raw: RawEmailInput): ReadableStream {
	const stream = new Response(toBytes(raw)).body;
	if (!stream) throw new Error('Failed to create stream from corpus case');
	return stream;
}

async function parseLegacy(raw: RawEmailInput): Promise<ParseResult> {
	try {
		const parsed = await parseEmailStream(toStream(raw), {
			decodeBody: defaultParserDependencies.decodeBody,
		});
		return { ok: true, parsed };
	} catch (error) {
		return { ok: false, error: String(error) };
	}
}

async function parseCurrent(raw: RawEmailInput): Promise<ParseResult> {
	try {
		const parsed = await parseEmailStream(toStream(raw));
		return { ok: true, parsed };
	} catch (error) {
		return { ok: false, error: String(error) };
	}
}

export async function runG3Comparison(): Promise<G3CompareReport> {
	const reports: CaseReport[] = [];

	for (const testCase of g3Corpus) {
		const legacy = await parseLegacy(testCase.raw);
		const current = await parseCurrent(testCase.raw);

		if (!legacy.ok || !current.ok) {
			const sameError = !legacy.ok && !current.ok && legacy.error === current.error;
			reports.push({
				id: testCase.id,
				group: testCase.group,
				description: testCase.description,
				status: sameError ? 'match' : 'error',
				criticalDiffCount: sameError ? 0 : 1,
				diffs: sameError
					? []
					: [{
						field: 'parse',
						category: 'payload_missing',
						critical: true,
						legacyValue: legacy.ok ? '' : legacy.error,
						currentValue: current.ok ? '' : current.error,
					}],
				error: {
					legacy: legacy.ok ? undefined : legacy.error,
					current: current.ok ? undefined : current.error,
				},
			});
			continue;
		}

		const envelope = {
			from: testCase.envelope?.from ?? 'sender@example.com',
			to: testCase.envelope?.to ?? 'receiver@example.com',
		};
		const legacyPayload = buildWebhookPayload(legacy.parsed, envelope);
		const currentPayload = buildWebhookPayload(current.parsed, envelope);
		const diffs = compareParsedAndPayload(legacy.parsed, current.parsed, legacyPayload, currentPayload);
		const criticalDiffCount = diffs.filter((item) => item.critical).length;
		reports.push({
			id: testCase.id,
			group: testCase.group,
			description: testCase.description,
			status: criticalDiffCount > 0 ? 'critical_diff' : 'match',
			criticalDiffCount,
			diffs,
		});
	}

	const total = reports.length;
	const matchedCases = reports.filter((entry) => entry.status === 'match').length;
	const criticalCaseCount = reports.filter((entry) => entry.criticalDiffCount > 0 || entry.status === 'error').length;
	const criticalDiffCount = reports.reduce((acc, entry) => acc + entry.criticalDiffCount, 0);
	const matchRate = (matchedCases / total) * 100;

	return {
		generatedAt: new Date().toISOString(),
		total,
		normalCount: reports.filter((entry) => entry.group === 'normal').length,
		errorCount: reports.filter((entry) => entry.group === 'error').length,
		matchedCases,
		matchRate,
		criticalCaseCount,
		criticalDiffCount,
		gate: {
			thresholdMatchRate: 99,
			requireZeroCriticalDiff: true,
			pass: matchRate >= 99 && criticalDiffCount === 0,
		},
		cases: reports,
	};
}

export function toMarkdown(report: G3CompareReport): string {
	const criticalCases = report.cases.filter((entry) => entry.criticalDiffCount > 0 || entry.status === 'error');
	const lines: string[] = [
		'# G3 Compare Report',
		'',
		'## 1. Scope',
		'- Compare legacy DI parser path and current postal-mime default path using fixed 30-case corpus.',
		'',
		'## 2. Corpus Summary',
		`- Total: ${report.total}`,
		`- Normal: ${report.normalCount}`,
		`- Error: ${report.errorCount}`,
		'',
		'## 3. Overall Result',
		`- Matched Cases: ${report.matchedCases}/${report.total}`,
		`- Mail-level Match Rate: ${report.matchRate.toFixed(2)}%`,
		`- Critical Diff Cases: ${report.criticalCaseCount}`,
		`- Critical Diff Count: ${report.criticalDiffCount}`,
		'',
		'## 4. Pass/Fail Gate (>=99% and zero critical)',
		`- Gate: ${report.gate.pass ? 'PASS' : 'FAIL'}`,
		'',
		'## 5. Critical Diffs',
	];

	if (criticalCases.length === 0) {
		lines.push('- None');
	} else {
		for (const item of criticalCases) {
			lines.push(`- ${item.id} (${item.group}) ${item.description}`);
			if (item.error) {
				lines.push(`  - legacy error: ${item.error.legacy ?? ''}`);
				lines.push(`  - current error: ${item.error.current ?? ''}`);
			}
			for (const diff of item.diffs.filter((entry) => entry.critical)) {
				lines.push(`  - [${diff.category}] ${diff.field}`);
			}
		}
	}

	lines.push('', '## 6. Raw Artifacts', '- artifacts/g3/g3-compare.json', '- artifacts/g3/g3-compare.md');
	return lines.join('\n');
}
