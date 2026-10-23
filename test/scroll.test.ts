import assert from "node:assert/strict";
import { test } from "node:test";
import type { Chunk } from "../src/shared/diff.ts";
import { changeIndexAt, mapLine } from "../src/shared/scroll.ts";

const modified: Chunk = { kind: "modified", oldStart: 10, oldEnd: 14, newStart: 10, newEnd: 12 };
const inserted: Chunk = { kind: "added", oldStart: 20, oldEnd: 20, newStart: 18, newEnd: 23 };
const deleted: Chunk = { kind: "deleted", oldStart: 30, oldEnd: 33, newStart: 33, newEnd: 33 };

test("no chunks maps to the same line", () => {
	assert.equal(mapLine([], 7.5, "old"), 7.5);
});

test("equal region before the first chunk keeps the position", () => {
	assert.equal(mapLine([modified], 4.25, "old"), 4.25);
});

test("inside a modified chunk it is proportional", () => {
	assert.equal(mapLine([modified], 12, "old"), 11);
	assert.equal(mapLine([modified], 11, "new"), 12);
});

test("after a chunk it is a constant offset", () => {
	assert.equal(mapLine([modified], 20, "old"), 18);
	assert.equal(mapLine([modified], 18, "new"), 20);
});

test("pure insert: new side inside maps to the old boundary", () => {
	assert.equal(mapLine([modified, inserted], 21, "new"), 20);
	assert.equal(mapLine([modified, inserted], 19.5, "new"), 20);
});

test("pure insert: old boundary jumps past the inserted lines", () => {
	assert.equal(mapLine([modified, inserted], 19.5, "old"), 17.5);
	assert.equal(mapLine([modified, inserted], 20, "old"), 23);
});

test("pure delete: old side inside maps to the new boundary", () => {
	assert.equal(mapLine([modified, inserted, deleted], 31.5, "old"), 33);
});

test("pure delete: new boundary jumps past the deleted lines", () => {
	assert.equal(mapLine([modified, inserted, deleted], 33, "new"), 33);
});

test("beyond the last chunk uses its closing offset", () => {
	assert.equal(mapLine([modified, inserted, deleted], 40, "old"), 40);
	assert.equal(mapLine([modified, inserted], 40, "old"), 43);
	assert.equal(mapLine([modified, inserted], 40, "new"), 37);
});

test("changeIndexAt is -1 above the first change", () => {
	assert.equal(changeIndexAt([modified, inserted], 5), -1);
});

test("changeIndexAt picks the last change at or above the focus line", () => {
	assert.equal(changeIndexAt([modified, inserted], 10), 0);
	assert.equal(changeIndexAt([modified, inserted], 30), 1);
});
