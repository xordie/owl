import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import { parseCommentArgs } from "../src/commentCommand.ts";
import type { Comment } from "../src/comments.ts";
import { findGitDir } from "../src/git.ts";
import { makeWorkingRepo } from "./helpers.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

function runCli(cwd: string, input: string | undefined, ...args: string[]) {
	return spawnSync("node", ["--disable-warning=ExperimentalWarning", CLI, ...args], { cwd, input, encoding: "utf8" });
}

test("parses a single comment for each source", () => {
	assert.deepEqual(parseCommentArgs(["src/x.ts:7-10", "hi"]), {
		kind: "add",
		source: "working",
		anchor: { path: "src/x.ts", side: "new", start: 7, end: 10 },
		text: "hi"
	});
	assert.deepEqual(parseCommentArgs(["--branch", "--old", "./a.ts:3", "-"]), {
		kind: "add",
		source: "branch",
		anchor: { path: "a.ts", side: "old", start: 3, end: 3 },
		text: "-"
	});
	assert.deepEqual(parseCommentArgs(["627", "a:b.ts:3", "5"]), {
		kind: "add",
		source: "pr-627",
		anchor: { path: "a:b.ts", side: "new", start: 3, end: 3 },
		text: "5"
	});
});

test("parses batch and clear forms", () => {
	assert.deepEqual(parseCommentArgs(["--batch"]), { kind: "batch", source: "working" });
	assert.deepEqual(parseCommentArgs(["627", "--batch"]), { kind: "batch", source: "pr-627" });
	assert.deepEqual(parseCommentArgs(["--clear", "--branch"]), { kind: "clear", source: "branch" });
	assert.deepEqual(parseCommentArgs(["--clear", "--all"]), { kind: "clear", source: null });
});

test("parses list and remove forms", () => {
	assert.deepEqual(parseCommentArgs(["--list"]), { kind: "list", source: "working" });
	assert.deepEqual(parseCommentArgs(["627", "--list"]), { kind: "list", source: "pr-627" });
	assert.deepEqual(parseCommentArgs(["--remove", "./a.ts:7-10"]), {
		kind: "remove",
		source: "working",
		match: { path: "a.ts", side: "new", start: 7, end: 10 }
	});
	assert.deepEqual(parseCommentArgs(["--branch", "--old", "--remove", "a.ts:3"]), {
		kind: "remove",
		source: "branch",
		match: { path: "a.ts", side: "old", start: 3, end: 3 }
	});
	assert.deepEqual(parseCommentArgs(["--remove", "a.ts"]), {
		kind: "remove",
		source: "working",
		match: { path: "a.ts" }
	});
	assert.deepEqual(parseCommentArgs(["627", "--old", "--remove", "a.ts"]), {
		kind: "remove",
		source: "pr-627",
		match: { path: "a.ts", side: "old" }
	});
});

test("rejects bad input", () => {
	assert.throws(() => parseCommentArgs(["a.ts", "hi"]), /expected <path>:<line>/);
	assert.throws(() => parseCommentArgs(["a.ts:x", "hi"]), /bad lines/);
	assert.throws(() => parseCommentArgs(["a.ts:0", "hi"]), /start at 1/);
	assert.throws(() => parseCommentArgs(["a.ts:9-3", "hi"]), /end is before start/);
	assert.throws(() => parseCommentArgs(["a/../b.ts:1", "hi"]), /"\.\."/);
	assert.throws(() => parseCommentArgs(["/etc/x:1", "hi"]), /relative/);
	assert.throws(() => parseCommentArgs([":1", "hi"]), /path is empty/);
	assert.throws(() => parseCommentArgs(["a.ts:1", "  "]), /text is empty/);
	assert.throws(() => parseCommentArgs(["a.ts:1", "x".repeat(20_001)]), /longer than/);
	assert.throws(() => parseCommentArgs(["--branch", "627", "a.ts:1", "hi"]), /not both/);
	assert.throws(() => parseCommentArgs(["--branch", "627", "--clear"]), /not both/);
	assert.throws(() => parseCommentArgs(["--list", "--remove", "a.ts"]), /use only one of/);
	assert.throws(() => parseCommentArgs(["--list", "--clear"]), /use only one of/);
	assert.throws(() => parseCommentArgs(["--list", "--all"]), /only works with --clear/);
	assert.throws(() => parseCommentArgs(["--list", "--old"]), /--old only works/);
	assert.throws(() => parseCommentArgs(["--remove"]), /expected <path>/);
	assert.throws(() => parseCommentArgs(["--remove", "../a.ts"]), /"\.\."/);
	assert.throws(() => parseCommentArgs(["--remove", "a.ts:5-2"]), /end is before start/);
	assert.throws(() => parseCommentArgs(["--remove", "--branch", "627", "a.ts"]), /not both/);
	assert.throws(() => parseCommentArgs(["--all"]), /needs|only works with --clear/);
	assert.throws(() => parseCommentArgs(["--batch", "--clear"]), /use only one of/);
	assert.throws(() => parseCommentArgs(["--clear", "--all", "--branch"]), /no other arguments/);
});

test("real CLI adds, replaces, reads stdin, batches and clears", async () => {
	const repo = makeWorkingRepo();
	const read = async (): Promise<Comment[]> =>
		JSON.parse(readFileSync(join((await findGitDir(repo))!, "owl", "comments.json"), "utf8"));

	const added = runCli(repo, undefined, "comment", "627", "mod.txt:2-3", "first");
	assert.equal(added.stdout, "comment added: pr-627 mod.txt:2-3\n");
	const replaced = runCli(repo, "from **stdin**\n- a\n", "comment", "627", "mod.txt:2-3", "-");
	assert.equal(replaced.stdout, "comment replaced: pr-627 mod.txt:2-3\n");
	assert.deepEqual(
		(await read()).map((comment) => comment.text),
		["from **stdin**\n- a"]
	);

	const batch = JSON.stringify([
		{ path: "mod.txt", lines: "1", text: "a" },
		{ path: "new.txt", lines: "1-2", old: true, text: "b" }
	]);
	assert.equal(runCli(repo, batch, "comment", "--batch").stdout, "2 comments added: working\n");
	assert.equal((await read()).length, 3);

	const bad = runCli(
		repo,
		JSON.stringify([
			{ path: "a", lines: "1", text: "ok" },
			{ path: "a", lines: "0", text: "x" }
		]),
		"comment",
		"--batch"
	);
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /item 1: lines start at 1/);
	assert.equal((await read()).length, 3);

	assert.equal(runCli(repo, undefined, "comment", "627", "--clear").stdout, "cleared 1 comments: pr-627\n");
	assert.equal(runCli(repo, undefined, "comment", "--clear", "--all").stdout, "cleared 2 comments: all\n");
});

test("real CLI prints the reason and usage for bad input, and fails outside a repo", () => {
	const repo = makeWorkingRepo();
	const bad = runCli(repo, undefined, "comment", "a.ts:5-2", "hi");
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /^owl: end is before start: 5-2\nusage: owl/);
	const outside = runCli("/", undefined, "comment", "a.ts:1", "hi");
	assert.equal(outside.stderr, "owl: not a git repository\n");
	assert.equal(outside.status, 1);
});

test("real CLI lists and removes comments", async () => {
	const repo = makeWorkingRepo();
	const gitDir = (await findGitDir(repo))!;
	const read = (): Comment[] => JSON.parse(readFileSync(join(gitDir, "owl", "comments.json"), "utf8"));
	assert.equal(runCli(repo, undefined, "comment", "--list").stdout, "no comments: working\n");

	const long = "x".repeat(100);
	const batch = [
		{ path: "mod.txt", lines: "2", text: "first\nsecond line" },
		{ path: "mod.txt", lines: "2-3", old: true, text: long },
		{ path: "mod.txt", lines: "5", text: "gone soon" },
		{ path: "new.txt", lines: "1", text: "keep" }
	];
	runCli(repo, JSON.stringify(batch), "comment", "--batch");
	runCli(repo, undefined, "comment", "627", "mod.txt:1", "other view");
	assert.equal(
		runCli(repo, undefined, "comment", "--list").stdout,
		`mod.txt:2  first\nmod.txt:2-3 (old)  ${"x".repeat(80)}\nmod.txt:5  gone soon\nnew.txt:1  keep\n`
	);

	assert.equal(
		runCli(repo, undefined, "comment", "--remove", "mod.txt:5").stdout,
		"removed 1 comments: working mod.txt:5\n"
	);
	assert.equal(
		runCli(repo, undefined, "comment", "--old", "--remove", "mod.txt").stdout,
		"removed 1 comments: working mod.txt\n"
	);
	assert.deepEqual(
		read().map((comment) => [comment.source, comment.path, comment.side]),
		[
			["working", "mod.txt", "new"],
			["working", "new.txt", "new"],
			["pr-627", "mod.txt", "new"]
		]
	);

	const before = readFileSync(join(gitDir, "owl", "comments.json"), "utf8");
	const miss = runCli(repo, undefined, "comment", "--remove", "mod.txt:9");
	assert.equal(miss.status, 1);
	assert.match(miss.stderr, /no comment matches mod\.txt:9/);
	assert.equal(readFileSync(join(gitDir, "owl", "comments.json"), "utf8"), before);

	assert.equal(
		runCli(repo, undefined, "comment", "--remove", "mod.txt").stdout,
		"removed 1 comments: working mod.txt\n"
	);
	assert.equal(read().length, 2);
});
