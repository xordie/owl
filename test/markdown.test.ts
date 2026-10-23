import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "../src/shared/markdown.ts";

test("html in the text comes out inert", () => {
	const actual = renderMarkdown(`<script>alert("x")</script> & 'y'`);
	assert.equal(actual, "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;</p>");
});

test("fenced block keeps its lines, takes the language and skips inline formatting", () => {
	const actual = renderMarkdown("```ts\nconst a = **1**;\n<b>\n```");
	assert.equal(actual, '<pre><code class="language-ts">const a = **1**;\n&lt;b&gt;</code></pre>');
});

test("fenced block without a language has no class", () => {
	assert.equal(renderMarkdown("```\nx\n```"), "<pre><code>x</code></pre>");
});

test("inline code and bold", () => {
	assert.equal(renderMarkdown("use `a **b**` and **c**"), "<p>use <code>a **b**</code> and <strong>c</strong></p>");
});

test("bullet and numbered lists", () => {
	assert.equal(renderMarkdown("- a\n* b"), "<ul><li>a</li><li>b</li></ul>");
	assert.equal(renderMarkdown("1. a\n2. **b**"), "<ol><li>a</li><li><strong>b</strong></li></ol>");
});

test("paragraphs split on blank lines and single newlines become br", () => {
	assert.equal(renderMarkdown("one\ntwo\n\nthree"), "<p>one<br>two</p><p>three</p>");
});

test("a list after a paragraph starts its own block", () => {
	assert.equal(renderMarkdown("intro\n- a"), "<p>intro</p><ul><li>a</li></ul>");
});
