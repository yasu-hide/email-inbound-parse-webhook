import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runBaselineComparison, toMarkdown } from '../test/baseline/run-baseline-compare';

async function main() {
	const report = await runBaselineComparison();
	const artifactsDir = path.join(process.cwd(), 'artifacts', 'baseline-comparison');
	await mkdir(artifactsDir, { recursive: true });
	await writeFile(path.join(artifactsDir, 'baseline-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
	await writeFile(path.join(artifactsDir, 'baseline-report.md'), `${toMarkdown(report)}\n`, 'utf-8');

	console.log(`[baseline] total=${report.total} matched=${report.matchedCases} matchRate=${report.matchRate.toFixed(2)}% critical=${report.criticalDiffCount}`);
	console.log(`[baseline] gate=${report.gate.pass ? 'PASS' : 'FAIL'} threshold=${report.gate.thresholdMatchRate}%`);
	console.log('[baseline] artifacts: artifacts/baseline-comparison/baseline-report.json, artifacts/baseline-comparison/baseline-report.md');

	if (process.env.BASELINE_GATE === '1' && !report.gate.pass) {
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error('[baseline] compare failed', error);
	process.exitCode = 1;
});
