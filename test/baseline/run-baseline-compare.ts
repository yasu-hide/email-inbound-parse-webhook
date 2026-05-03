import { parseEmailStream, type ParsedResult } from '../../src/email-parser';
import { inspectMultipartFallbackForRawInput, type MultipartFallbackReason } from '../../src/email-parser/postal-mime-adapter';
import { buildWebhookPayload } from '../../src/webhook-payload-builder';
import { compareParsedAndPayload, type DiffItem } from './comparison-helpers';
import { baselineCases, type RawEmailInput } from './cases';
import expectedResults from './expected-results.json';

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
		expected?: string;
		current?: string;
	};
	multipartFallback?: {
		contentType?: string;
		shouldFallback: boolean;
		reason?: MultipartFallbackReason;
	};
};

export type BaselineCompareReport = {
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

type BaselineExpectedCase =
	| { id: string; status: 'ok'; parsed: ParsedResult; payload: ReturnType<typeof buildWebhookPayload> }
	| { id: string; status: 'error'; error: string };

const expectedCaseList = expectedResults as BaselineExpectedCase[];
const expectedCaseMap = new Map<string, BaselineExpectedCase>(
	expectedCaseList.map((entry) => [entry.id, entry]),
);

async function parseCurrent(raw: RawEmailInput): Promise<ParseResult> {
	try {
		const parsed = await parseEmailStream(toStream(raw));
		return { ok: true, parsed };
	} catch (error) {
		return { ok: false, error: String(error) };
	}
}

export async function runBaselineComparison(): Promise<BaselineCompareReport> {
	const reports: CaseReport[] = [];
	const caseIdSet = new Set(baselineCases.map((entry) => entry.id));

	for (const testCase of baselineCases) {
		const fallbackInspection = await inspectMultipartFallbackForRawInput(testCase.raw);
		const multipartFallback = fallbackInspection.isMultipart
			? {
				contentType: fallbackInspection.contentType,
				shouldFallback: fallbackInspection.shouldFallback,
				reason: fallbackInspection.reason,
			}
			: undefined;

		const expected = expectedCaseMap.get(testCase.id);
		if (!expected) {
			reports.push({
				id: testCase.id,
				group: testCase.group,
				description: testCase.description,
				status: 'error',
				criticalDiffCount: 1,
				diffs: [{
					field: 'expected_results',
					category: 'payload_missing',
					critical: true,
					legacyValue: 'present',
					currentValue: 'missing',
					note: 'expected_case_missing',
				}],
				error: { expected: 'expected results case missing', current: undefined },
				multipartFallback,
			});
			continue;
		}

		const current = await parseCurrent(testCase.raw);

		if (expected.status === 'error' || !current.ok) {
			const sameError = expected.status === 'error' && !current.ok && expected.error === current.error;
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
						legacyValue: expected.status === 'error' ? expected.error : '',
						currentValue: current.ok ? '' : current.error,
					}],
				error: {
					expected: expected.status === 'error' ? expected.error : undefined,
					current: current.ok ? undefined : current.error,
				},
				multipartFallback,
			});
			continue;
		}

		if (expected.status !== 'ok') {
			continue;
		}

		const envelope = {
			from: testCase.envelope?.from ?? 'sender@example.com',
			to: testCase.envelope?.to ?? 'receiver@example.com',
		};
		const currentPayload = buildWebhookPayload(current.parsed, envelope);
		const diffs = compareParsedAndPayload(expected.parsed, current.parsed, expected.payload, currentPayload);
		const criticalDiffCount = diffs.filter((item) => item.critical).length;
		reports.push({
			id: testCase.id,
			group: testCase.group,
			description: testCase.description,
			status: criticalDiffCount > 0 ? 'critical_diff' : 'match',
			criticalDiffCount,
			diffs,
				multipartFallback,
		});
	}

	for (const expected of expectedCaseList) {
		if (caseIdSet.has(expected.id)) {
			continue;
		}
		reports.push({
			id: expected.id,
			group: 'error',
			description: 'expected results case exists but baseline case entry is missing',
			status: 'error',
			criticalDiffCount: 1,
			diffs: [{
				field: 'corpus',
				category: 'payload_missing',
				critical: true,
				legacyValue: 'missing',
				currentValue: 'present',
				note: 'corpus_case_missing',
			}],
				error: { expected: 'expected results case has no baseline case entry', current: undefined },
				multipartFallback: undefined,
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

export function toMarkdown(report: BaselineCompareReport): string {
	const criticalCases = report.cases.filter((entry) => entry.criticalDiffCount > 0 || entry.status === 'error');
	const lines: string[] = [
		'# Baseline Compare Report',
		'',
		'## 1. Scope',
		`- Compare fixed expected results and current parser output using fixed ${report.total}-case baseline cases.`,
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
			if (item.multipartFallback) {
				lines.push(`  - multipart fallback: ${item.multipartFallback.shouldFallback ? 'yes' : 'no'}`);
				if (item.multipartFallback.reason) {
					lines.push(`  - fallback reason: ${item.multipartFallback.reason}`);
				}
			}
			if (item.error) {
				lines.push(`  - expected error: ${item.error.expected ?? ''}`);
				lines.push(`  - current error: ${item.error.current ?? ''}`);
			}
			for (const diff of item.diffs.filter((entry) => entry.critical)) {
				lines.push(`  - [${diff.category}] ${diff.field}`);
			}
		}
	}

	lines.push('', '## 6. Raw Artifacts', '- artifacts/baseline-comparison/baseline-report.json', '- artifacts/baseline-comparison/baseline-report.md');
	return lines.join('\n');
}
