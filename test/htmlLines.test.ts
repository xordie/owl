import assert from "node:assert/strict";
import { test } from "node:test";
import { splitHighlightedLines } from "../src/shared/htmlLines.ts";

test("splits plain text on newlines", () => {
	assert.deepEqual(splitHighlightedLines("a\nb"), ["a", "b"]);
});

test("closes and reopens spans around a newline", () => {
	const html = '<span class="c">/* one\ntwo */</span> x';
	assert.deepEqual(splitHighlightedLines(html), ['<span class="c">/* one</span>', '<span class="c">two */</span> x']);
});

test("reopens nested spans in order", () => {
	const html = '<span class="a"><span class="b">x\ny</span></span>';
	assert.deepEqual(splitHighlightedLines(html), [
		'<span class="a"><span class="b">x</span></span>',
		'<span class="a"><span class="b">y</span></span>'
	]);
});

test("keeps empty lines in the middle", () => {
	assert.deepEqual(splitHighlightedLines("a\n\nb"), ["a", "", "b"]);
});

test("drops the empty line after a trailing newline", () => {
	assert.deepEqual(splitHighlightedLines("a\nb\n"), ["a", "b"]);
});

test("drops the span-only line left by a trailing newline inside a span", () => {
	assert.deepEqual(splitHighlightedLines('<span class="c">/* a\n</span>'), ['<span class="c">/* a</span>']);
});

test("empty text has no lines", () => {
	assert.deepEqual(splitHighlightedLines(""), []);
});
