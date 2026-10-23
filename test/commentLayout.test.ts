import assert from "node:assert/strict";
import { test } from "node:test";
import type { Comment } from "../src/comments.ts";
import type { Chunk } from "../src/shared/diff.ts";
import {
	barLines,
	commentForChunk,
	countByPath,
	describeLines,
	groupByStart,
	nextCommentIndex,
	stackCards
} from "../src/shared/comment-layout.ts";

function comment(id: string, start: number, end = start, path = "a.ts", source = "working"): Comment {
	return { id, source, path, side: "new", start, end, text: id, createdAt: "2026-01-01T00:00:00Z" };
}

test("comments starting on the same line share a group, in written order", () => {
	const groups = groupByStart([comment("x", 9), comment("y", 3), comment("z", 9, 12)], 50);
	assert.deepEqual(
		groups.map((group) => [group.line, group.comments.map((c) => c.id)]),
		[
			[3, ["y"]],
			[9, ["x", "z"]]
		]
	);
});

test("start lines past the end are clamped to the last line", () => {
	const groups = groupByStart([comment("x", 80), comment("y", 99)], 10);
	assert.deepEqual(
		groups.map((group) => [group.line, group.comments.length]),
		[[10, 2]]
	);
});

test("an empty file has no groups", () => {
	assert.deepEqual(groupByStart([comment("x", 1)], 0), []);
});

test("bar lines cover every range and clamp at the end", () => {
	assert.deepEqual(
		[...barLines([comment("x", 2, 4), comment("y", 4, 5), comment("z", 9, 20)], 10)],
		[2, 3, 4, 5, 9, 10]
	);
});

test("stacked cards keep their anchor when there is room", () => {
	assert.deepEqual(
		stackCards(
			[
				{ anchor: 0, height: 40 },
				{ anchor: 100, height: 40 }
			],
			6
		),
		[0, 100]
	);
});

test("a card that would overlap is pushed below the one above", () => {
	const tops = stackCards(
		[
			{ anchor: 0, height: 40 },
			{ anchor: 18, height: 30 },
			{ anchor: 20, height: 10 }
		],
		6
	);
	assert.deepEqual(tops, [0, 46, 82]);
});

test("a card far below a pushed stack goes back to its anchor", () => {
	assert.deepEqual(
		stackCards(
			[
				{ anchor: 0, height: 100 },
				{ anchor: 500, height: 20 }
			],
			6
		),
		[0, 500]
	);
});

test("counts are per path and only for the source", () => {
	const counts = countByPath(
		[comment("x", 1), comment("y", 2), comment("z", 1, 1, "b.ts"), comment("w", 1, 1, "a.ts", "branch")],
		"working"
	);
	assert.deepEqual(
		[...counts],
		[
			["a.ts", 2],
			["b.ts", 1]
		]
	);
});

test("next steps through the list and stays put past the end", () => {
	const list = [comment("a", 1), comment("b", 2), comment("c", 3)];
	const any = (): boolean => true;
	assert.equal(nextCommentIndex(list, -1, 1, any), 0);
	assert.equal(nextCommentIndex(list, 1, 1, any), 2);
	assert.equal(nextCommentIndex(list, 2, 1, any), 2);
	assert.equal(nextCommentIndex(list, 2, -1, any), 1);
	assert.equal(nextCommentIndex(list, 0, -1, any), 0);
	assert.equal(nextCommentIndex(list, -1, -1, any), -1);
});

test("comments of files that are not openable are skipped", () => {
	const list = [comment("a", 1, 1, "gone.ts"), comment("b", 1, 1, "ok.ts"), comment("c", 1, 1, "gone.ts")];
	const openable = (c: Comment): boolean => c.path === "ok.ts";
	assert.equal(nextCommentIndex(list, -1, 1, openable), 1);
	assert.equal(nextCommentIndex(list, 1, 1, openable), 1);
	assert.equal(nextCommentIndex(list, 1, -1, openable), 1);
});

test("a stale index past the end still steps back", () => {
	const list = [comment("a", 1), comment("b", 2)];
	assert.equal(
		nextCommentIndex(list, 5, -1, () => true),
		1
	);
});

test("lines are described as one or a range", () => {
	assert.equal(describeLines(comment("a", 7)), "line 7");
	assert.equal(describeLines(comment("a", 7, 10)), "lines 7–10");
});

function onSide(side: "old" | "new", id: string, start: number, end = start): Comment {
	return { ...comment(id, start, end), side };
}

const modified: Chunk = { kind: "modified", oldStart: 9, oldEnd: 12, newStart: 9, newEnd: 11 };
const inserted: Chunk = { kind: "added", oldStart: 20, oldEnd: 20, newStart: 20, newEnd: 24 };
const deleted: Chunk = { kind: "deleted", oldStart: 30, oldEnd: 33, newStart: 35, newEnd: 35 };

test("a comment overlapping a modified chunk on the new side belongs to it", () => {
	assert.equal(commentForChunk([comment("x", 11, 15)], modified)?.id, "x");
	assert.equal(commentForChunk([comment("x", 1, 10)], modified)?.id, "x");
	assert.equal(commentForChunk([comment("x", 12, 15)], modified), undefined);
});

test("for a pure insert the old side touches the line after the boundary", () => {
	assert.equal(commentForChunk([onSide("old", "x", 21)], inserted)?.id, "x");
	assert.equal(commentForChunk([onSide("old", "x", 20)], inserted), undefined);
	assert.equal(commentForChunk([comment("y", 24)], inserted)?.id, "y");
});

test("an old-side comment belongs to a pure delete, a new-side one at the boundary too", () => {
	assert.equal(commentForChunk([onSide("old", "x", 32)], deleted)?.id, "x");
	assert.equal(commentForChunk([comment("y", 36)], deleted)?.id, "y");
	assert.equal(commentForChunk([comment("y", 35)], deleted), undefined);
});

test("a comment elsewhere does not belong to the chunk", () => {
	assert.equal(commentForChunk([comment("x", 1, 3), comment("y", 50)], modified), undefined);
});

test("with several overlapping, the lowest new-side start wins, then the old side", () => {
	const list = [onSide("old", "o", 9), comment("b", 10), comment("a", 5, 10)];
	assert.equal(commentForChunk(list, modified)?.id, "a");
	assert.equal(commentForChunk([onSide("old", "o2", 11), onSide("old", "o1", 10)], modified)?.id, "o1");
});
