import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import { addComments, clearComments, deleteComment, readComments, removeComments } from "../src/comments.ts";
import type { CommentDraft } from "../src/comments.ts";
import { parseBatch } from "../src/commentCommand.ts";
import { commitAll, git, makeTempDir, makeWorkingRepo } from "./helpers.ts";
import { findGitDir } from "../src/git.ts";

function draft(path: string, start: number, text: string, end = start): CommentDraft {
	return { path, side: "new", start, end, text };
}

test("missing file means no comments", async () => {
	assert.deepEqual(await readComments(makeTempDir()), []);
});

test("append keeps written order and fills id and createdAt", async () => {
	const gitDir = makeTempDir();
	await addComments(gitDir, "working", [draft("a.ts", 5, "first"), draft("b.ts", 1, "second", 3)]);
	const actual = await readComments(gitDir);
	assert.deepEqual(
		actual.map((comment) => [comment.path, comment.start, comment.end, comment.text, comment.source]),
		[
			["a.ts", 5, 5, "first", "working"],
			["b.ts", 1, 3, "second", "working"]
		]
	);
	assert.match(actual[0].id, /^[0-9a-f-]{36}$/);
	assert.ok(!Number.isNaN(Date.parse(actual[0].createdAt)));
});

test("same source, path, side, start and end replaces text and keeps id and position", async () => {
	const gitDir = makeTempDir();
	await addComments(gitDir, "working", [draft("a.ts", 5, "one"), draft("a.ts", 9, "two")]);
	const before = await readComments(gitDir);
	const results = await addComments(gitDir, "working", [draft("a.ts", 5, "changed")]);
	const actual = await readComments(gitDir);
	assert.deepEqual(results, ["replaced"]);
	assert.deepEqual(
		actual.map((comment) => [comment.id, comment.text]),
		[
			[before[0].id, "changed"],
			[before[1].id, "two"]
		]
	);
});

test("another source, side or range is a separate comment", async () => {
	const gitDir = makeTempDir();
	await addComments(gitDir, "working", [draft("a.ts", 5, "one")]);
	await addComments(gitDir, "branch", [draft("a.ts", 5, "one")]);
	await addComments(gitDir, "working", [{ ...draft("a.ts", 5, "one"), side: "old" }, draft("a.ts", 5, "one", 6)]);
	assert.equal((await readComments(gitDir)).length, 4);
});

test("clear removes one source, clear all removes everything", async () => {
	const gitDir = makeTempDir();
	await addComments(gitDir, "working", [draft("a.ts", 1, "w")]);
	await addComments(gitDir, "pr-627", [draft("a.ts", 1, "p1"), draft("a.ts", 2, "p2")]);
	assert.equal(await clearComments(gitDir, "pr-627"), 2);
	assert.deepEqual(
		(await readComments(gitDir)).map((comment) => comment.source),
		["working"]
	);
	assert.equal(await clearComments(gitDir, null), 1);
	assert.deepEqual(await readComments(gitDir), []);
});

test("deleteComment removes by id and reports unknown ids", async () => {
	const gitDir = makeTempDir();
	await addComments(gitDir, "working", [draft("a.ts", 1, "x")]);
	const [{ id }] = await readComments(gitDir);
	assert.equal(await deleteComment(gitDir, "00000000-0000-0000-0000-000000000000"), false);
	assert.equal(await deleteComment(gitDir, id), true);
	assert.deepEqual(await readComments(gitDir), []);
});

test("batch parses every item", () => {
	const actual = parseBatch(
		JSON.stringify([
			{ path: "./a.ts", lines: "7", text: " hi " },
			{ path: "b.ts", lines: "7-10", old: true, text: "yo" }
		])
	);
	assert.deepEqual(actual, [
		{ path: "a.ts", side: "new", start: 7, end: 7, text: "hi" },
		{ path: "b.ts", side: "old", start: 7, end: 10, text: "yo" }
	]);
});

test("a bad batch item rejects the batch and names its index", () => {
	const input = JSON.stringify([
		{ path: "a.ts", lines: "1", text: "ok" },
		{ path: "a.ts", lines: "1", text: "ok" },
		{ path: "../a.ts", lines: "1", text: "ok" }
	]);
	assert.throws(() => parseBatch(input), /^Error: item 2: path must not contain/);
	assert.throws(() => parseBatch("not json"), /not valid JSON/);
	assert.throws(() => parseBatch("[]"), /non-empty/);
	assert.throws(() => parseBatch('[{"path":"a","lines":7,"text":"x"}]'), /item 0: lines must be a string/);
});

test("a comment added inside a worktree lands in that worktree's git dir", async () => {
	const repo = makeWorkingRepo();
	commitAll(repo, "second");
	const worktree = join(makeTempDir(), "wt");
	git(repo, "worktree", "add", "-q", "-b", "side", worktree);
	const worktreeGitDir = await findGitDir(worktree);
	const mainGitDir = await findGitDir(repo);
	assert.ok(worktreeGitDir !== null && mainGitDir !== null && worktreeGitDir !== mainGitDir);
	await addComments(worktreeGitDir, "working", [draft("a.ts", 1, "x")]);
	assert.ok(existsSync(join(worktreeGitDir, "owl", "comments.json")));
	assert.ok(!existsSync(join(mainGitDir, "owl", "comments.json")));
});

test("removeComments matches exact range, or path on one or both sides, within one source", async () => {
	const gitDir = makeTempDir();
	await addComments(gitDir, "working", [
		draft("a.ts", 5, "n5"),
		draft("a.ts", 5, "n5-7", 7),
		{ ...draft("a.ts", 5, "old5"), side: "old" },
		draft("b.ts", 5, "b")
	]);
	await addComments(gitDir, "branch", [draft("a.ts", 5, "other source")]);
	assert.equal(await removeComments(gitDir, "working", { path: "a.ts", side: "new", start: 5, end: 5 }), 1);
	assert.equal(await removeComments(gitDir, "working", { path: "a.ts", side: "old" }), 1);
	assert.equal(await removeComments(gitDir, "working", { path: "nope.ts" }), 0);
	assert.equal(await removeComments(gitDir, "working", { path: "a.ts" }), 1);
	assert.deepEqual(
		(await readComments(gitDir)).map((comment) => comment.text),
		["b", "other source"]
	);
});
