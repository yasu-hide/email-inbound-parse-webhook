import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runG3Comparison, toMarkdown } from '../test/g3/run-compare';

async function main() {
	const report = await runG3Comparison();
	const artifactsDir = path.join(process.cwd(), 'artifacts', 'g3');
	await mkdir(artifactsDir, { recursive: true });
	await writeFile(path.join(artifactsDir, 'g3-compare.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
	await writeFile(path.join(artifactsDir, 'g3-compare.md'), `${toMarkdown(report)}\n`, 'utf-8');

	console.log(`[g3] total=${report.total} matched=${report.matchedCases} matchRate=${report.matchRate.toFixed(2)}% critical=${report.criticalDiffCount}`);
	console.log(`[g3] gate=${report.gate.pass ? 'PASS' : 'FAIL'} threshold=${report.gate.thresholdMatchRate}%`);
	console.log('[g3] artifacts: artifacts/g3/g3-compare.json, artifacts/g3/g3-compare.md');

	if (process.env.G3_GATE === '1' && !report.gate.pass) {
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error('[g3] compare failed', error);
	process.exitCode = 1;
});
