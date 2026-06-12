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

type DiffReport = {
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

type BatchItem = {
	information: string;
	metadata: Record<string, unknown>;
};

type BatchReport = {
	generatedAt: string;
	repo: string;
	baseRef: string;
	dedupeMode: 'path-latest';
	totalItemsBeforeDedupe: number;
	totalItems: number;
	fileFullItems: number;
	fileSummaryItems: number;
	symbolItems: number;
	droppedByDedupe: number;
	items: BatchItem[];
};

function metadataPath(item: BatchItem): string {
	const raw = item.metadata.path;
	return typeof raw === 'string' ? raw : '';
}

function latestOnlyByPath(items: BatchItem[]): BatchItem[] {
	const pathToItem = new Map<string, BatchItem>();
	for (const item of items) {
		const key = metadataPath(item);
		if (!key) continue;
		if (pathToItem.has(key)) {
			// Keep insertion order aligned with "latest wins" semantics.
			pathToItem.delete(key);
		}
		pathToItem.set(key, item);
	}
	return [...pathToItem.values()];
}

async function readJson<T>(filePath: string): Promise<T> {
	const raw = await readFile(filePath, 'utf-8');
	return JSON.parse(raw) as T;
}

function repoNameFromCwd(cwd: string): string {
	return path.basename(cwd);
}

function compactSummary(target: Target): string {
	const lines: string[] = [];
	lines.push(`repo: ${repoNameFromCwd(process.cwd())}`);
	lines.push(`nodeType: ${target.nodeType}`);
	lines.push(`nodeId: ${target.nodeId}`);
	lines.push(`path: ${target.path}`);
	lines.push(`strategy: ${target.strategy}`);
	lines.push(`sourceKind: ${target.sourceKind}`);
	lines.push(`lineCount: ${target.lineCount}`);
	if (target.symbolName) lines.push(`symbolName: ${target.symbolName}`);
	if (target.parentPath) lines.push(`parentPath: ${target.parentPath}`);
	if (target.links.length > 0) lines.push(`links: ${target.links.join(', ')}`);
	if (target.searchHints.length > 0) lines.push(`searchHints: ${target.searchHints.join(', ')}`);
	if (target.imports && target.imports.length > 0) lines.push(`imports: ${target.imports.join(', ')}`);
	if (target.exports && target.exports.length > 0) lines.push(`exports: ${target.exports.join(', ')}`);
	lines.push('');
	lines.push('summary:');
	lines.push(`- ${target.reason}`);
	return lines.join('\n');
}

function normalizeContent(content: string): string {
	return content.replace(/\r\n/g, '\n').trimEnd();
}

async function toBatchItem(target: Target): Promise<BatchItem> {
	const repo = repoNameFromCwd(process.cwd());
	const metadata: Record<string, unknown> = {
		repo,
		path: target.path,
		nodeType: target.nodeType,
		nodeId: target.nodeId,
		strategy: target.strategy,
		sourceKind: target.sourceKind,
		lineCount: target.lineCount,
		links: target.links,
		searchHints: target.searchHints,
	};

	if (target.symbolName) metadata.symbolName = target.symbolName;
	if (target.parentPath) metadata.parentPath = target.parentPath;
	if (target.imports && target.imports.length > 0) metadata.imports = target.imports;
	if (target.exports && target.exports.length > 0) metadata.exports = target.exports;

	if (target.nodeType === 'file' && target.strategy === 'full') {
		const raw = await readFile(path.join(process.cwd(), target.path), 'utf-8');
		const body = normalizeContent(raw);
		const information = [
			`repo: ${repo}`,
			`path: ${target.path}`,
			`language: ${path.extname(target.path).slice(1) || 'text'}`,
			`kind: source_code`,
			'',
			body,
		].join('\n');
		return { information, metadata };
	}

	const information = compactSummary(target);
	return { information, metadata };
}

async function main() {
	const inPath = process.env.QDRANT_DIFF_TARGETS_PATH?.trim()
		|| path.join(process.cwd(), 'artifacts', 'qdrant', 'diff-targets.json');
	const outPath = process.env.QDRANT_STORE_BATCH_PATH?.trim()
		|| path.join(process.cwd(), 'artifacts', 'qdrant', 'store-batch.json');

	const report = await readJson<DiffReport>(inPath);
	const rawItems: BatchItem[] = [];

	for (const target of report.targets) {
		try {
			rawItems.push(await toBatchItem(target));
		} catch (_error) {
			// Skip unreadable files to keep batch generation resilient.
		}
	}

	const items = latestOnlyByPath(rawItems);

	const batch: BatchReport = {
		generatedAt: new Date().toISOString(),
		repo: repoNameFromCwd(process.cwd()),
		baseRef: report.baseRef,
		dedupeMode: 'path-latest',
		totalItemsBeforeDedupe: rawItems.length,
		totalItems: items.length,
		fileFullItems: items.filter((item) => item.metadata.nodeType === 'file' && item.metadata.strategy === 'full').length,
		fileSummaryItems: items.filter((item) => item.metadata.nodeType === 'file' && item.metadata.strategy === 'summary').length,
		symbolItems: items.filter((item) => item.metadata.nodeType === 'symbol').length,
		droppedByDedupe: rawItems.length - items.length,
		items,
	};

	await mkdir(path.dirname(outPath), { recursive: true });
	await writeFile(outPath, `${JSON.stringify(batch, null, 2)}\n`, 'utf-8');

	console.log(`[qdrant] batch generated: ${path.relative(process.cwd(), outPath)}`);
	console.log(`[qdrant] dedupe=${batch.dedupeMode} before=${batch.totalItemsBeforeDedupe} after=${batch.totalItems} dropped=${batch.droppedByDedupe}`);
	console.log(`[qdrant] total=${batch.totalItems} full=${batch.fileFullItems} summary=${batch.fileSummaryItems} symbol=${batch.symbolItems}`);
	console.log('[qdrant] next: ingest each item.information + item.metadata via qdrant-store');
}

main().catch((error) => {
	console.error('[qdrant] failed to generate store batch', error);
	process.exitCode = 1;
});
