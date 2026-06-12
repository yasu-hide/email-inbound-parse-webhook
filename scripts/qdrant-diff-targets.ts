import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type Strategy = 'full' | 'summary';
type NodeType = 'file' | 'symbol';
type SourceKind = 'source' | 'test' | 'doc' | 'config' | 'generated' | 'other';

type Target = {
	nodeType: NodeType;
	nodeId: string;
	path: string;
	lineCount: number;
	strategy: Strategy;
	reason: string;
	sourceKind: SourceKind;
	links: string[];
	searchHints: string[];
	imports?: string[];
	exports?: string[];
	symbolName?: string;
	parentPath?: string;
};

type Report = {
	generatedAt: string;
	baseRef: string;
	totalTargets: number;
	fullTargets: number;
	summaryTargets: number;
	totalNodes: number;
	fileNodes: number;
	symbolNodes: number;
	targets: Target[];
};

const EXCLUDE_PATTERNS = [
	/^node_modules\//,
	/^\.git\//,
	/^artifacts\//,
	/^bundled\//,
	/^dist\//,
	/^coverage\//,
	/\.pem$/,
	/^\.env/,
];

const FULL_ALLOWED_EXTENSIONS = new Set([
	'.ts',
	'.mts',
	'.tsx',
	'.js',
	'.mjs',
	'.cjs',
	'.json',
	'.jsonc',
	'.yaml',
	'.yml',
	'.toml',
	'.md',
	'.txt',
	'.html',
	'.css',
]);

const LINKABLE_EXTENSIONS = new Set([
	'.ts',
	'.mts',
	'.tsx',
	'.js',
	'.mjs',
	'.cjs',
	'.md',
	'.json',
	'.jsonc',
	'.yaml',
	'.yml',
	'.toml',
]);

const DOC_LINK_TARGETS = ['README.md', 'SPEC.md', 'PAYLOAD_CONTRACT_CHECKLIST.md', 'DEPLOY.md'];

function runGit(args: string[]): string {
	return execFileSync('git', args, { encoding: 'utf-8' }).trim();
}

function tryRunGit(args: string[]): string | null {
	try {
		return runGit(args);
	} catch (_error) {
		return null;
	}
}

function pickBaseRef(): string {
	const cliBase = process.argv
		.slice(2)
		.map((arg) => arg.trim())
		.find((arg) => arg.length > 0 && arg !== '--');
	if (cliBase) return cliBase;

	const envBase = process.env.QDRANT_BASE?.trim();
	if (envBase) return envBase;

	const mergeBase = tryRunGit(['merge-base', 'HEAD', 'origin/main']);
	if (mergeBase) return mergeBase;

	return 'HEAD~1';
}

function listChangedFiles(baseRef: string): string[] {
	const diffOut = tryRunGit(['diff', '--name-only', '--diff-filter=ACMRTUXB', `${baseRef}...HEAD`])
		?? tryRunGit(['diff', '--name-only', '--diff-filter=ACMRTUXB', baseRef, 'HEAD'])
		?? '';
	const unstagedOut = tryRunGit(['diff', '--name-only']) ?? '';
	const stagedOut = tryRunGit(['diff', '--name-only', '--cached']) ?? '';
	const untrackedOut = tryRunGit(['ls-files', '--others', '--exclude-standard']) ?? '';

	const files = new Set<string>();
	for (const chunk of [diffOut, unstagedOut, stagedOut, untrackedOut]) {
		for (const line of chunk.split('\n')) {
			const file = line.trim();
			if (!file) continue;
			files.add(file);
		}
	}

	return [...files].sort((a, b) => a.localeCompare(b));
}

function shouldExclude(filePath: string): boolean {
	return EXCLUDE_PATTERNS.some((pattern) => pattern.test(filePath));
}

function classify(filePath: string, lineCount: number): Pick<Target, 'strategy' | 'reason'> {
	const ext = path.extname(filePath).toLowerCase();
	if (!FULL_ALLOWED_EXTENSIONS.has(ext)) {
		return { strategy: 'summary', reason: `extension ${ext || '(none)'} is not in full-ingest allowlist` };
	}

	if (lineCount > 450) {
		return { strategy: 'summary', reason: `large file (${lineCount} lines)` };
	}

	return { strategy: 'full', reason: `small/medium text file (${lineCount} lines)` };
}

function classifySourceKind(filePath: string): SourceKind {
	if (filePath === 'worker-configuration.d.ts') return 'generated';
	if (filePath.endsWith('pnpm-lock.yaml')) return 'generated';
	if (filePath.startsWith('src/')) return 'source';
	if (filePath.startsWith('test/')) return 'test';
	if (filePath.startsWith('docs/') || filePath.endsWith('.md')) return 'doc';
	if (filePath.startsWith('scripts/') || filePath.endsWith('.json') || filePath.endsWith('.jsonc') || filePath.endsWith('.yaml') || filePath.endsWith('.yml') || filePath.endsWith('.toml')) {
		return 'config';
	}
	return 'other';
}

function tokenize(value: string): string[] {
	return value
		.split(/[^a-zA-Z0-9_]+/)
		.map((item) => item.trim().toLowerCase())
		.filter((item) => item.length >= 2);
}

function uniqueSorted(values: string[]): string[] {
	return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function parseImports(content: string): string[] {
	const imports: string[] = [];
	const fromPattern = /from\s+['"]([^'"]+)['"]/g;
	const sideEffectPattern = /import\s+['"]([^'"]+)['"]/g;
	let match: RegExpExecArray | null;
	while ((match = fromPattern.exec(content)) !== null) {
		imports.push(match[1]);
	}
	while ((match = sideEffectPattern.exec(content)) !== null) {
		imports.push(match[1]);
	}
	return uniqueSorted(imports);
}

function parseExportedSymbols(content: string): string[] {
	const symbols: string[] = [];
	const declarationPattern = /export\s+(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
	const reExportPattern = /export\s*\{([^}]+)\}/g;
	let match: RegExpExecArray | null;

	while ((match = declarationPattern.exec(content)) !== null) {
		symbols.push(match[1]);
	}

	while ((match = reExportPattern.exec(content)) !== null) {
		const names = match[1]
			.split(',')
			.map((item) => item.trim())
			.filter(Boolean)
			.map((item) => {
				const aliasParts = item.split(/\s+as\s+/i);
				return aliasParts[aliasParts.length - 1].trim();
			});
		symbols.push(...names);
	}

	return uniqueSorted(symbols);
}

function resolveLocalImportPath(currentPath: string, importPath: string, knownFiles: Set<string>): string | null {
	if (!importPath.startsWith('.')) return null;

	const currentDir = path.posix.dirname(currentPath);
	const normalized = path.posix.normalize(path.posix.join(currentDir, importPath));
	const candidates = [
		normalized,
		`${normalized}.ts`,
		`${normalized}.tsx`,
		`${normalized}.mts`,
		`${normalized}.js`,
		`${normalized}.mjs`,
		`${normalized}.cjs`,
		`${normalized}.d.ts`,
		`${normalized}.json`,
		`${normalized}.md`,
		path.posix.join(normalized, 'index.ts'),
		path.posix.join(normalized, 'index.tsx'),
		path.posix.join(normalized, 'index.mts'),
		path.posix.join(normalized, 'index.js'),
		path.posix.join(normalized, 'index.mjs'),
		path.posix.join(normalized, 'index.cjs'),
	];

	for (const candidate of candidates) {
		if (knownFiles.has(candidate)) return candidate;
	}

	return null;
}

function guessTestLinks(filePath: string, knownFiles: Set<string>): string[] {
	if (!filePath.startsWith('src/')) return [];
	const ext = path.posix.extname(filePath);
	const relativeToSrc = filePath.slice('src/'.length, filePath.length - ext.length);
	const candidates = [
		`test/${relativeToSrc}.spec.ts`,
		`test/${path.posix.basename(relativeToSrc)}.spec.ts`,
	];
	return uniqueSorted(candidates.filter((candidate) => knownFiles.has(candidate)));
}

function buildFileSearchHints(filePath: string, sourceKind: SourceKind, imports: string[], exports: string[]): string[] {
	const hints = [
		...tokenize(filePath),
		sourceKind,
		...imports.flatMap((item) => tokenize(item)),
		...exports.flatMap((item) => tokenize(item)),
	];
	return uniqueSorted(hints);
}

function buildSymbolSearchHints(symbolName: string, filePath: string, sourceKind: SourceKind): string[] {
	return uniqueSorted([
		...tokenize(symbolName),
		...tokenize(filePath),
		sourceKind,
		'symbol',
	]);
}

async function countLines(filePath: string): Promise<number> {
	const content = await readFile(filePath, 'utf-8');
	return content.length === 0 ? 0 : content.split('\n').length;
}

function toMarkdown(report: Report): string {
	const lines: string[] = [];
	lines.push('# Qdrant Diff Targets');
	lines.push('');
	lines.push(`- Generated: ${report.generatedAt}`);
	lines.push(`- Base Ref: ${report.baseRef}`);
	lines.push(`- Total: ${report.totalTargets}`);
	lines.push(`- Full: ${report.fullTargets}`);
	lines.push(`- Summary: ${report.summaryTargets}`);
	lines.push(`- Nodes: ${report.totalNodes} (file=${report.fileNodes}, symbol=${report.symbolNodes})`);
	lines.push('');
	lines.push('## Targets');
	for (const target of report.targets) {
		lines.push(`- [${target.strategy}] [${target.nodeType}] ${target.path} (${target.lineCount} lines) - ${target.reason}`);
		if (target.symbolName) {
			lines.push(`  - symbol: ${target.symbolName}`);
		}
		if (target.links.length > 0) {
			lines.push(`  - links: ${target.links.join(', ')}`);
		}
	}
	lines.push('');
	lines.push('## Next');
	lines.push('- Feed `[full]` files to `qdrant-store` with full content.');
	lines.push('- Feed `[summary]` files to `qdrant-store` with concise summaries.');
	lines.push('- Two-step search: first by feature intent, then by `links` tokens (tested_by / related_doc / imports / belongs_to).');
	return lines.join('\n');
}

async function main() {
	const baseRef = pickBaseRef();
	const changed = listChangedFiles(baseRef).filter((f) => !shouldExclude(f));
	const trackedFilesRaw = tryRunGit(['ls-files']) ?? '';
	const trackedFiles = trackedFilesRaw
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
	const knownFiles = new Set<string>([...trackedFiles, ...changed]);

	const targets: Target[] = [];
	for (const relativePath of changed) {
		try {
			const ext = path.extname(relativePath).toLowerCase();
			const lineCount = await countLines(relativePath);
			const content = await readFile(relativePath, 'utf-8');
			const { strategy, reason } = classify(relativePath, lineCount);
			const sourceKind = classifySourceKind(relativePath);
			const imports = LINKABLE_EXTENSIONS.has(ext) ? parseImports(content) : [];
			const exports = LINKABLE_EXTENSIONS.has(ext) ? parseExportedSymbols(content) : [];
			const importLinks = imports
				.map((item) => resolveLocalImportPath(relativePath, item, knownFiles))
				.filter((item): item is string => Boolean(item))
				.map((item) => `imports:file:${item}`);
			const testLinks = guessTestLinks(relativePath, knownFiles).map((item) => `tested_by:file:${item}`);
			const docLinks = DOC_LINK_TARGETS
				.filter((item) => knownFiles.has(item) && item !== relativePath)
				.map((item) => `related_doc:file:${item}`);
			const links = uniqueSorted([...importLinks, ...testLinks, ...docLinks]);
			const searchHints = buildFileSearchHints(relativePath, sourceKind, imports, exports);

			targets.push({
				nodeType: 'file',
				nodeId: `file:${relativePath}`,
				path: relativePath,
				lineCount,
				strategy,
				reason,
				sourceKind,
				links,
				searchHints,
				imports,
				exports,
			});

			for (const symbolName of exports) {
				targets.push({
					nodeType: 'symbol',
					nodeId: `symbol:${relativePath}#${symbolName}`,
					path: relativePath,
					lineCount,
					strategy: 'summary',
					reason: `symbol card derived from ${relativePath}`,
					sourceKind,
					links: uniqueSorted([
						`belongs_to:file:${relativePath}`,
						...testLinks,
						...docLinks,
					]),
					searchHints: buildSymbolSearchHints(symbolName, relativePath, sourceKind),
					symbolName,
					parentPath: relativePath,
				});
			}
		} catch (_error) {
			// Skip deleted/binary/unreadable files.
		}
	}

	const fileTargets = targets.filter((t) => t.nodeType === 'file');
	const symbolTargets = targets.filter((t) => t.nodeType === 'symbol');

	const report: Report = {
		generatedAt: new Date().toISOString(),
		baseRef,
		totalTargets: fileTargets.length,
		fullTargets: fileTargets.filter((t) => t.strategy === 'full').length,
		summaryTargets: fileTargets.filter((t) => t.strategy === 'summary').length,
		totalNodes: targets.length,
		fileNodes: fileTargets.length,
		symbolNodes: symbolTargets.length,
		targets,
	};

	const outDir = path.join(process.cwd(), 'artifacts', 'qdrant');
	await mkdir(outDir, { recursive: true });

	const jsonPath = path.join(outDir, 'diff-targets.json');
	const mdPath = path.join(outDir, 'diff-targets.md');

	await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
	await writeFile(mdPath, `${toMarkdown(report)}\n`, 'utf-8');

	console.log(`[qdrant] baseRef=${baseRef}`);
	console.log(`[qdrant] total=${report.totalTargets} full=${report.fullTargets} summary=${report.summaryTargets}`);
	console.log(`[qdrant] nodes=${report.totalNodes} fileNodes=${report.fileNodes} symbolNodes=${report.symbolNodes}`);
	console.log(`[qdrant] artifacts: ${path.relative(process.cwd(), jsonPath)}, ${path.relative(process.cwd(), mdPath)}`);
}

main().catch((error) => {
	console.error('[qdrant] failed to generate diff targets', error);
	process.exitCode = 1;
});
