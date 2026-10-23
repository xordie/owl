import type { Chunk } from "./diff.ts";

export type Side = "old" | "new";

export function mapLine(chunks: Chunk[], position: number, from: Side): number {
	const to: Side = from === "old" ? "new" : "old";
	let offsetAfterChunk = 0;
	for (const chunk of chunks) {
		const [fromStart, fromEnd] = bounds(chunk, from);
		const [toStart, toEnd] = bounds(chunk, to);
		if (position < fromStart) return position + toStart - fromStart;
		if (position < fromEnd) return toStart + ((position - fromStart) / (fromEnd - fromStart)) * (toEnd - toStart);
		offsetAfterChunk = toEnd - fromEnd;
	}
	return position + offsetAfterChunk;
}

function bounds(chunk: Chunk, side: Side): [start: number, end: number] {
	return side === "old" ? [chunk.oldStart, chunk.oldEnd] : [chunk.newStart, chunk.newEnd];
}

export function changeIndexAt(chunks: Chunk[], focusLine: number): number {
	let index = -1;
	chunks.forEach((chunk, i) => {
		if (chunk.newStart <= focusLine) index = i;
	});
	return index;
}
