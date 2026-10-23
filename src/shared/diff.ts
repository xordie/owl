export type ChunkKind = "added" | "deleted" | "modified";
export type WordRange = [line: number, fromCol: number, toCol: number];

export interface Chunk {
	kind: ChunkKind;
	oldStart: number;
	oldEnd: number;
	newStart: number;
	newEnd: number;
	oldWords?: WordRange[];
	newWords?: WordRange[];
}

type OffsetRange = [from: number, to: number];

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const TOKEN = /\w+|[^\S\n]+|\n|[^\w\s]/g;
const MAX_WORD_DIFF_LINES = 200;
const MAX_LCS_CELLS = 1_000_000;

export function parseHunks(diff: string): Chunk[] {
	const chunks: Chunk[] = [];
	for (const line of diff.split("\n")) {
		const match = HUNK_HEADER.exec(line);
		if (match) chunks.push(chunkFromHeader(match));
	}
	return chunks;
}

export function addWordDiffs(chunks: Chunk[], oldText: string, newText: string): Chunk[] {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	return chunks.map((chunk) => (chunk.kind === "modified" ? withWords(chunk, oldLines, newLines) : chunk));
}

function chunkFromHeader(match: RegExpExecArray): Chunk {
	const oldCount = match[2] === undefined ? 1 : Number(match[2]);
	const newCount = match[4] === undefined ? 1 : Number(match[4]);
	const oldStart = zeroBasedStart(Number(match[1]), oldCount);
	const newStart = zeroBasedStart(Number(match[3]), newCount);
	return {
		kind: kindOf(oldCount, newCount),
		oldStart,
		oldEnd: oldStart + oldCount,
		newStart,
		newEnd: newStart + newCount
	};
}

function zeroBasedStart(headerStart: number, count: number): number {
	return count === 0 ? headerStart : headerStart - 1;
}

function kindOf(oldCount: number, newCount: number): ChunkKind {
	if (oldCount === 0) return "added";
	if (newCount === 0) return "deleted";
	return "modified";
}

function withWords(chunk: Chunk, oldLines: string[], newLines: string[]): Chunk {
	const oldBlock = oldLines.slice(chunk.oldStart, chunk.oldEnd);
	const newBlock = newLines.slice(chunk.newStart, chunk.newEnd);
	if (oldBlock.length > MAX_WORD_DIFF_LINES || newBlock.length > MAX_WORD_DIFF_LINES) return chunk;
	const oldTokens = tokenize(oldBlock.join("\n"));
	const newTokens = tokenize(newBlock.join("\n"));
	const kept = keptTokens(oldTokens, newTokens);
	if (kept === null) return chunk;
	const { oldKept, newKept } = kept;
	return {
		...chunk,
		oldWords: toLineRanges(oldBlock, changedRanges(oldTokens, oldKept), chunk.oldStart),
		newWords: toLineRanges(newBlock, changedRanges(newTokens, newKept), chunk.newStart)
	};
}

function tokenize(text: string): string[] {
	return text.match(TOKEN) ?? [];
}

function keptTokens(a: string[], b: string[]): { oldKept: boolean[]; newKept: boolean[] } | null {
	const oldKept = a.map(() => false);
	const newKept = b.map(() => false);
	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < a.length - prefix &&
		suffix < b.length - prefix &&
		a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
	)
		suffix++;
	const middleA = a.slice(prefix, a.length - suffix);
	const middleB = b.slice(prefix, b.length - suffix);
	if ((middleA.length + 1) * (middleB.length + 1) > MAX_LCS_CELLS) return null;
	markKept(oldKept, 0, prefix);
	markKept(newKept, 0, prefix);
	markKept(oldKept, a.length - suffix, a.length);
	markKept(newKept, b.length - suffix, b.length);
	markLcs(middleA, middleB, oldKept, newKept, prefix);
	return { oldKept, newKept };
}

function markKept(kept: boolean[], from: number, to: number): void {
	for (let i = from; i < to; i++) kept[i] = true;
}

// ponytail: O(n*m) table on the middle part only, word diff is skipped above 1M cells, switch to Myers to lift that
function markLcs(a: string[], b: string[], oldKept: boolean[], newKept: boolean[], offset: number): void {
	const width = b.length + 1;
	const table = new Uint32Array((a.length + 1) * width);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			table[i * width + j] =
				a[i] === b[j]
					? table[(i + 1) * width + j + 1] + 1
					: Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
		}
	}
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			oldKept[offset + i] = true;
			newKept[offset + j] = true;
			i++;
			j++;
		} else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
		else j++;
	}
}

function changedRanges(tokens: string[], kept: boolean[]): OffsetRange[] {
	const ranges: OffsetRange[] = [];
	let offset = 0;
	tokens.forEach((token, index) => {
		const end = offset + token.length;
		const last = ranges[ranges.length - 1];
		if (!kept[index]) {
			if (last && last[1] === offset) last[1] = end;
			else ranges.push([offset, end]);
		}
		offset = end;
	});
	return ranges;
}

function toLineRanges(block: string[], ranges: OffsetRange[], firstLine: number): WordRange[] {
	const result: WordRange[] = [];
	let lineStart = 0;
	block.forEach((line, index) => {
		const lineEnd = lineStart + line.length;
		for (const [from, to] of ranges) {
			const segmentFrom = Math.max(from, lineStart);
			const segmentTo = Math.min(to, lineEnd);
			if (segmentFrom < segmentTo) result.push([firstLine + index, segmentFrom - lineStart, segmentTo - lineStart]);
		}
		lineStart = lineEnd + 1;
	});
	return result;
}
