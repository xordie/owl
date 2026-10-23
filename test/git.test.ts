import assert from "node:assert/strict";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readFileDetail, readSources, resolveSource } from "../src/git.ts";
import { commitAll, git, makeRepoWithOrigin, makeWorkingRepo, write } from "./helpers.ts";

function byPath(files: { path: string }[]): string[] {
	return files.map((file) => file.path).sort();
}

test("branch view lists only the branch's files, even when origin main moved on", async () => {
	const { seed, clone } = makeRepoWithOrigin();
	git(clone, "checkout", "-q", "-b", "feature");
	write(clone, "a.txt", "one\nTWO\nthree\n");
	write(clone, "b.txt", "new\n");
	commitAll(clone, "feature work");
	write(seed, "c.txt", "newer\n");
	commitAll(seed, "main moved");
	git(seed, "push", "-q", "origin", "main");
	git(clone, "fetch", "-q", "origin");

	const actual = await resolveSource(clone, "branch");

	assert.deepEqual(byPath(actual.files), ["a.txt", "b.txt"]);
	assert.equal(actual.commitCount, 1);
	const sources = await readSources(clone);
	assert.equal(sources.defaultBranch, "main");
	assert.deepEqual(sources.branchView, { commitCount: 1, fileCount: 2 });
	assert.ok(sources.prError);
});

test("branch view is empty on the default branch", async () => {
	const { clone } = makeRepoWithOrigin();
	const actual = await resolveSource(clone, "branch");
	assert.deepEqual(actual.files, []);
});

test("branch view file detail has chunks and word ranges", async () => {
	const { clone } = makeRepoWithOrigin();
	git(clone, "checkout", "-q", "-b", "feature");
	write(clone, "a.txt", "one\nTWO\nthree\n");
	commitAll(clone, "feature work");
	const source = await resolveSource(clone, "branch");

	const actual = await readFileDetail(clone, source, source.files[0]);

	assert.ok("chunks" in actual);
	assert.deepEqual(actual.chunks, [
		{ kind: "modified", oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 2, oldWords: [[1, 0, 3]], newWords: [[1, 0, 3]] }
	]);
});

test("working view: modified, deleted, staged rename, untracked", async () => {
	const repo = makeWorkingRepo();

	const actual = await resolveSource(repo, "working");

	assert.deepEqual(
		actual.files.sort((a, b) => a.path.localeCompare(b.path)),
		[
			{ path: "del.txt", status: "deleted" },
			{ path: "mod.txt", status: "modified" },
			{ path: "new.txt", status: "added" },
			{ path: "renamed.txt", oldPath: "old.txt", status: "renamed" }
		]
	);
});

test("working view details: untracked is all added, deleted is all deleted, modified has a chunk", async () => {
	const repo = makeWorkingRepo();
	const source = await resolveSource(repo, "working");
	const detail = (path: string) =>
		readFileDetail(
			repo,
			source,
			source.files.find((file) => file.path === path)!
		);

	const added = await detail("new.txt");
	const deleted = await detail("del.txt");
	const modified = await detail("mod.txt");
	const renamed = await detail("renamed.txt");

	assert.ok("chunks" in added && "chunks" in deleted && "chunks" in modified && "chunks" in renamed);
	assert.deepEqual(added.chunks, [{ kind: "added", oldStart: 0, oldEnd: 0, newStart: 0, newEnd: 2 }]);
	assert.deepEqual(deleted.chunks, [{ kind: "deleted", oldStart: 0, oldEnd: 1, newStart: 0, newEnd: 0 }]);
	assert.equal(modified.chunks[0].kind, "modified");
	assert.equal(modified.newText, "a\nB\nc\n");
	assert.equal(renamed.oldPath, "old.txt");
	assert.deepEqual(renamed.chunks, []);
});

test("binary file is flagged", async () => {
	const repo = makeWorkingRepo();
	write(repo, "blob.bin", "abc\0def");
	const source = await resolveSource(repo, "working");

	const actual = await readFileDetail(repo, source, { path: "blob.bin", status: "added" });

	assert.ok("binary" in actual && actual.binary);
});

test("too large file is flagged with line counts", async () => {
	const repo = makeWorkingRepo();
	write(repo, "big.txt", "x\n".repeat(20001));
	const source = await resolveSource(repo, "working");

	const actual = await readFileDetail(repo, source, { path: "big.txt", status: "added" });

	assert.ok("tooLarge" in actual);
	assert.deepEqual(actual.tooLarge, { oldLines: 0, newLines: 20001 });
});

test("symlink in the working view shows the link target, not the target's content", async () => {
	const repo = makeWorkingRepo();
	symlinkSync("mod.txt", join(repo, "link"));
	const source = await resolveSource(repo, "working");

	const actual = await readFileDetail(repo, source, { path: "link", status: "added" });

	assert.ok("newText" in actual);
	assert.equal(actual.newText, "mod.txt");
});
