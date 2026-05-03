import { describe, expect, it } from 'vitest';
import { runG3Comparison } from './run-compare';

describe('g3 compare runner', () => {
	it('generates G3 comparison report artifacts', async () => {
			const output = await runG3Comparison();

			if (process.env.G3_GATE === '1') {
				expect(output.gate.pass).toBe(true);
			}

			expect(output.total).toBe(30);
	});
});
