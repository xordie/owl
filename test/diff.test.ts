import assert from "node:assert/strict";
import { test } from "node:test";
import { addWordDiffs, parseHunks } from "../src/shared/diff.ts";
import type { Chunk } from "../src/shared/diff.ts";

test("insert at top of file", () => {
	const actual = parseHunks("@@ -0,0 +1,2 @@\n+a\n+b\n");
	assert.deepEqual(actual, [{ kind: "added", oldStart: 0, oldEnd: 0, newStart: 0, newEnd: 2 }]);
});

test("pure insert in the middle starts after the line before it", () => {
	const actual = parseHunks("@@ -3,0 +4,2 @@\n+a\n+b\n");
	assert.deepEqual(actual, [{ kind: "added", oldStart: 3, oldEnd: 3, newStart: 3, newEnd: 5 }]);
});

test("pure delete", () => {
	const actual = parseHunks("@@ -5,2 +4,0 @@\n-a\n-b\n");
	assert.deepEqual(actual, [{ kind: "deleted", oldStart: 4, oldEnd: 6, newStart: 4, newEnd: 4 }]);
});

test("modify with different sizes", () => {
	const actual = parseHunks("@@ -2,3 +2,2 @@\n-a\n-b\n-c\n+d\n+e\n");
	assert.deepEqual(actual, [{ kind: "modified", oldStart: 1, oldEnd: 4, newStart: 1, newEnd: 3 }]);
});

test("omitted counts mean one line", () => {
	const actual = parseHunks("@@ -7 +7 @@\n-a\n+b\n");
	assert.deepEqual(actual, [{ kind: "modified", oldStart: 6, oldEnd: 7, newStart: 6, newEnd: 7 }]);
});

test("no-newline marker is ignored", () => {
	const actual = parseHunks("@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n");
	assert.deepEqual(actual, [{ kind: "modified", oldStart: 0, oldEnd: 1, newStart: 0, newEnd: 1 }]);
});

test("several hunks in order", () => {
	const actual = parseHunks("@@ -1 +1 @@\n-a\n+b\n@@ -9,0 +10 @@\n+c\n");
	assert.equal(actual.length, 2);
	assert.equal(actual[1].kind, "added");
});

test("word diff on one line", () => {
	const chunk: Chunk = { kind: "modified", oldStart: 0, oldEnd: 1, newStart: 0, newEnd: 1 };
	const [actual] = addWordDiffs([chunk], "const foo = 1;", "const bar = 1;");
	assert.deepEqual(actual.oldWords, [[0, 6, 9]]);
	assert.deepEqual(actual.newWords, [[0, 6, 9]]);
});

test("word diff uses absolute line numbers and merges neighbours", () => {
	const chunk: Chunk = { kind: "modified", oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 2 };
	const [actual] = addWordDiffs([chunk], "a\nfoo bar\n", "a\nfoo baz qux\n");
	assert.deepEqual(actual.oldWords, [[1, 4, 7]]);
	assert.deepEqual(actual.newWords, [[1, 4, 11]]);
});

test("word diff ranges split at line breaks", () => {
	const chunk: Chunk = { kind: "modified", oldStart: 0, oldEnd: 2, newStart: 0, newEnd: 2 };
	const [actual] = addWordDiffs([chunk], "x one\ntwo y", "x 1\n2 y");
	assert.deepEqual(actual.oldWords, [
		[0, 2, 5],
		[1, 0, 3]
	]);
	assert.deepEqual(actual.newWords, [
		[0, 2, 3],
		[1, 0, 1]
	]);
});

test("word diff is skipped for blocks over 200 lines", () => {
	const lines = Array.from({ length: 201 }, (_, i) => `line ${i}`);
	const chunk: Chunk = { kind: "modified", oldStart: 0, oldEnd: 201, newStart: 0, newEnd: 201 };
	const [actual] = addWordDiffs([chunk], lines.join("\n"), lines.join("\n") + "x");
	assert.equal(actual.oldWords, undefined);
});

test("added chunks get no word diff", () => {
	const chunk: Chunk = { kind: "added", oldStart: 0, oldEnd: 0, newStart: 0, newEnd: 1 };
	assert.deepEqual(addWordDiffs([chunk], "", "a\n"), [chunk]);
});

test("word diff is skipped when the token table would be too big", () => {
	const lines = Array.from({ length: 150 }, (_, i) => `a${i} b${i} c${i} d${i} e${i}`);
	const oldText = lines.map((line) => `o ${line} o`).join("\n");
	const newText = lines.map((line) => `n ${line} n`).join("\n");
	const chunk: Chunk = { kind: "modified", oldStart: 0, oldEnd: 150, newStart: 0, newEnd: 150 };
	const [actual] = addWordDiffs([chunk], oldText, newText);
	assert.equal(actual.oldWords, undefined);
	assert.equal(actual.newWords, undefined);
});
