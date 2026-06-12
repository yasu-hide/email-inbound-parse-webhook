import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type Theme = {
	id: 'parse' | 'signature' | 'payload';
	hop1Query: string;
	hop2Query: string;
	hop2File: string;
	requiredPaths: string[];
};

type Check = {
	theme: Theme['id'];
	hop2File: string;
	requiredPath: string;
	result: 'PASS' | 'FAIL';
};

type ValidationReport = {
	generatedAt: string;
	totalChecks: number;
	passedChecks: number;
	failedChecks: number;
	gate: 'PASS' | 'FAIL';
	themes: Theme[];
	checks: Check[];
};

const QUERY_RESULTS_DIR = path.join(process.cwd(), 'artifacts', 'qdrant', 'query-results');

const THEMES: Theme[] = [
	{
		id: 'parse',
		hop1Query: 'parseEmailStream postal mime fallback behavior',
		hop2Query: 'belongs_to:file:src/email-parser.ts tested_by:file:test/mime-parser.spec.ts related_doc:file:SPEC.md',
		hop2File: path.join(QUERY_RESULTS_DIR, 'parse-hop2.txt'),
		requiredPaths: ['src/email-parser.ts', 'test/mime-parser.spec.ts', 'SPEC.md'],
	},
	{
		id: 'signature',
		hop1Query: 'webhook ECDSA signature timestamp body',
		hop2Query: 'belongs_to:file:src/webhook-signature.ts tested_by:file:test/webhook-signature.spec.ts related_doc:file:README.md',
		hop2File: path.join(QUERY_RESULTS_DIR, 'signature-hop2.txt'),
		requiredPaths: ['src/webhook-signature.ts', 'test/webhook-signature.spec.ts', 'README.md'],
	},
	{
		id: 'payload',
		hop1Query: 'buildWebhookPayload charsets form-data fields',
		hop2Query: 'belongs_to:file:src/webhook-payload-builder.ts tested_by:file:test/webhook-payload-builder.spec.ts related_doc:file:PAYLOAD_CONTRACT_CHECKLIST.md',
		hop2File: path.join(QUERY_RESULTS_DIR, 'payload-hop2.txt'),
		requiredPaths: ['src/webhook-payload-builder.ts', 'test/webhook-payload-builder.spec.ts', 'PAYLOAD_CONTRACT_CHECKLIST.md'],
	},
];

function tryParseJsonAsText(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return raw;
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		return JSON.stringify(parsed);
	} catch (_error) {
		return raw;
	}
}

function toMarkdown(report: ValidationReport): string {
	const lines: string[] = [];
	lines.push('# Qdrant Two-Hop Validation');
	lines.push('');
	lines.push(`- Generated: ${report.generatedAt}`);
	lines.push('- Scope: 3 themes x 2-hop queries (1st intent query + 2nd links query)');
	lines.push('');
	lines.push('## Query Set');
	lines.push('');

	for (const theme of report.themes) {
		lines.push(`### ${theme.id}`);
		lines.push(`- Hop1: \`${theme.hop1Query}\``);
		lines.push(`- Hop2: \`${theme.hop2Query}\``);
		lines.push(`- Hop2 Result File: \`${path.relative(process.cwd(), theme.hop2File)}\``);
		lines.push('');
	}

	lines.push('## Results');
	lines.push('');
	lines.push('| Theme | Required Path | Result |');
	lines.push('|---|---|---|');
	for (const check of report.checks) {
		lines.push(`| ${check.theme} | ${check.requiredPath} | ${check.result} |`);
	}
	lines.push('');
	lines.push('## Summary');
	lines.push('');
	lines.push(`- Total checks: ${report.totalChecks}`);
	lines.push(`- Passed: ${report.passedChecks}`);
	lines.push(`- Failed: ${report.failedChecks}`);
	lines.push(`- Gate: ${report.gate}`);
	return lines.join('\n');
}

async function main() {
	const checks: Check[] = [];

	for (const theme of THEMES) {
		let text = '';
		try {
			const raw = await readFile(theme.hop2File, 'utf-8');
			text = tryParseJsonAsText(raw);
		} catch (_error) {
			text = '';
		}

		for (const requiredPath of theme.requiredPaths) {
			const result: Check['result'] = text.includes(requiredPath) ? 'PASS' : 'FAIL';
			checks.push({
				theme: theme.id,
				hop2File: theme.hop2File,
				requiredPath,
				result,
			});
		}
	}

	const totalChecks = checks.length;
	const passedChecks = checks.filter((check) => check.result === 'PASS').length;
	const failedChecks = totalChecks - passedChecks;
	const gate: ValidationReport['gate'] = failedChecks === 0 ? 'PASS' : 'FAIL';

	const report: ValidationReport = {
		generatedAt: new Date().toISOString(),
		totalChecks,
		passedChecks,
		failedChecks,
		gate,
		themes: THEMES,
		checks,
	};

	const outDir = path.join(process.cwd(), 'artifacts', 'qdrant');
	const outJson = path.join(outDir, 'two-hop-validation.json');
	const outMd = path.join(outDir, 'two-hop-validation.md');
	await mkdir(outDir, { recursive: true });
	await writeFile(outJson, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
	await writeFile(outMd, `${toMarkdown(report)}\n`, 'utf-8');

	console.log(`[qdrant] validation: ${path.relative(process.cwd(), outMd)}`);
	console.log(`[qdrant] checks=${totalChecks} pass=${passedChecks} fail=${failedChecks} gate=${gate}`);

	if (process.env.QDRANT_TWO_HOP_GATE === '1' && gate === 'FAIL') {
		console.error('[qdrant] gate failed (set QDRANT_TWO_HOP_GATE=1)');
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error('[qdrant] failed to validate two-hop results', error);
	process.exitCode = 1;
});
