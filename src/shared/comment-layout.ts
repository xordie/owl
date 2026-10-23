import type { Comment } from "../comments.ts";
import type { Chunk } from "./diff.ts";

export interface CommentGroup {
	line: number;
	comments: Comment[];
}

export interface CardBox {
	anchor: number;
	height: number;
}

export function groupByStart(comments: Comment[], lineCount: number): CommentGroup[] {
	if (lineCount < 1) return [];
	const byLine = new Map<number, Comment[]>();
	for (const comment of comments) {
		const line = Math.min(comment.start, lineCount);
		byLine.set(line, [...(byLine.get(line) ?? []), comment]);
	}
	return [...byLine].map(([line, grouped]) => ({ line, comments: grouped })).sort((a, b) => a.line - b.line);
}

export function barLines(comments: Comment[], lineCount: number): Set<number> {
	const lines = new Set<number>();
	for (const { start, end } of comments) {
		for (let line = Math.min(start, lineCount); line <= Math.min(end, lineCount); line++) lines.add(line);
	}
	return lines;
}

export function stackCards(boxes: CardBox[], gap: number): number[] {
	let floor = -Infinity;
	return boxes.map(({ anchor, height }) => {
		const top = Math.max(anchor, floor);
		floor = top + height + gap;
		return top;
	});
}

export function countByPath(comments: Comment[], source: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const comment of comments) {
		if (comment.source === source) counts.set(comment.path, (counts.get(comment.path) ?? 0) + 1);
	}
	return counts;
}

export function nextCommentIndex(
	comments: Comment[],
	current: number,
	direction: 1 | -1,
	isOpenable: (comment: Comment) => boolean
): number {
	const first = direction === 1 ? current + 1 : Math.min(current - 1, comments.length - 1);
	for (let index = first; index >= 0 && index < comments.length; index += direction) {
		if (isOpenable(comments[index])) return index;
	}
	return current;
}

export function describeLines({ start, end }: Comment): string {
	return start === end ? `line ${start}` : `lines ${start}–${end}`;
}

export function commentForChunk(comments: Comment[], chunk: Chunk): Comment | undefined {
	const touching = (comment: Comment): boolean => {
		const [first, last] = comment.side === "new" ? [chunk.newStart, chunk.newEnd] : [chunk.oldStart, chunk.oldEnd];
		return comment.start <= Math.max(last, first + 1) && comment.end >= first + 1;
	};
	const bySide = (side: Comment["side"]): Comment[] =>
		comments.filter((comment) => comment.side === side && touching(comment)).sort((a, b) => a.start - b.start);
	return [...bySide("new"), ...bySide("old")][0];
}
