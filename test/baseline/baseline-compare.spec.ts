import { describe, expect, it } from 'vitest';
import { runBaselineComparison } from './run-baseline-compare';
import { baselineCases } from './cases';

describe('baseline compare runner', () => {
	it('generates baseline comparison report artifacts', async () => {
			const output = await runBaselineComparison();

			if (process.env.BASELINE_GATE === '1') {
				expect(output.gate.pass).toBe(true);
			}

			expect(output.total).toBe(baselineCases.length);
	});
});
