import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { addComments, readComments } from "../src/comments.ts";
import { findGitDir } from "../src/git.ts";
import { startServer } from "../src/server.ts";
import type { RunningServer } from "../src/server.ts";
import { commitAll, git, makeRepoWithOrigin, makeTempDir, makeWorkingRepo, write } from "./helpers.ts";

let running: RunningServer;
let gitDir: string;

before(async () => {
	const repo = makeWorkingRepo();
	gitDir = (await findGitDir(repo))!;
	running = await startServer(repo, () => undefined);
});

after(() => {
	running.server.closeAllConnections();
	running.server.close();
});

function get(
	path: string,
	host?: string,
	port = running.port,
	method = "GET"
): Promise<{ status: number; body: string }> {
	return new Promise((done, fail) => {
		const headers = host === undefined ? undefined : { host };
		const req = request({ host: "127.0.0.1", port, path, headers, method }, (res) => {
			let body = "";
			res.on("data", (chunk: Buffer) => (body += chunk));
			res.on("end", () => done({ status: res.statusCode ?? 0, body }));
		});
		req.on("error", fail);
		req.end();
	});
}

test("foreign Host header gets 403", async () => {
	const actual = await get("/api/sources", "evil.example.com");
	assert.equal(actual.status, 403);
});

test("localhost Host header is accepted", async () => {
	const actual = await get("/api/files?source=working", `localhost:${running.port}`);
	assert.equal(actual.status, 200);
});

test("bad source gets 400", async () => {
	assert.equal((await get("/api/files?source=nope")).status, 400);
	assert.equal((await get("/api/file?source=pr-x&path=a")).status, 400);
});

test("path outside the file list gets 404", async () => {
	await get("/api/files?source=working");
	assert.equal((await get("/api/file?source=working&path=../../etc/passwd")).status, 404);
	assert.equal((await get("/api/file?source=working&path=nope.txt")).status, 404);
});

test("path in the file list returns its detail", async () => {
	await get("/api/files?source=working");
	const actual = await get("/api/file?source=working&path=mod.txt");
	assert.equal(actual.status, 200);
	assert.equal(JSON.parse(actual.body).newText, "a\nB\nc\n");
});

test("path in the file list is required before the first files call", async () => {
	assert.equal((await get("/api/file?source=branch&path=a.txt")).status, 404);
});

test("shared and client files are served, with types stripped", async () => {
	const shared = await get("/shared/diff.ts");
	assert.equal(shared.status, 200);
	assert.ok(!shared.body.includes("export type"));
	assert.equal((await get("/")).status, 200);
});

test("files outside client and shared are not served", async () => {
	assert.equal((await get("/client/../git.ts")).status, 404);
	assert.equal((await get("/client/%2e%2e/git.ts")).status, 404);
	assert.equal((await get("/shared/..%2fcli.ts")).status, 404);
});

test("pr source is cached until refresh=1", async () => {
	const { seed, clone } = makeRepoWithOrigin();
	git(seed, "checkout", "-q", "-b", "pr");
	write(seed, "pr.txt", "hello\n");
	commitAll(seed, "pr change");
	const sha = git(seed, "rev-parse", "HEAD").trim();
	git(seed, "push", "-q", "origin", "pr");
	git(join(dirname(seed), "origin.git"), "update-ref", "refs/pull/1/head", sha);

	const bin = makeTempDir();
	const counter = join(bin, "calls");
	const view = JSON.stringify({
		number: 1,
		title: "t",
		author: { login: "me" },
		url: "http://pr/1",
		baseRefName: "main",
		headRefOid: sha
	});
	writeFileSync(join(bin, "gh"), `#!/bin/sh\necho x >> "${counter}"\necho '${view}'\n`, { mode: 0o755 });
	const calls = (): number => readFileSync(counter, "utf8").trim().split("\n").length;

	const originalPath = process.env.PATH;
	process.env.PATH = `${bin}:${originalPath}`;
	const prServer = await startServer(clone, () => undefined);
	try {
		const first = await get("/api/files?source=pr-1", undefined, prServer.port);
		assert.deepEqual(
			(JSON.parse(first.body) as { files: { path: string }[] }).files.map((file) => file.path),
			["pr.txt"]
		);
		await get("/api/files?source=pr-1", undefined, prServer.port);
		assert.equal(calls(), 1);
		await get("/api/files?source=pr-1&refresh=1", undefined, prServer.port);
		assert.equal(calls(), 2);
	} finally {
		process.env.PATH = originalPath;
		prServer.server.closeAllConnections();
		prServer.server.close();
	}
});

const SAMPLE = { path: "a.ts", side: "new", start: 1, end: 2, text: "hi" } as const;

test("GET /api/comments returns all comments", async () => {
	await addComments(gitDir, "working", [SAMPLE]);
	const actual = JSON.parse((await get("/api/comments")).body) as { comments: { text: string }[] };
	assert.ok(actual.comments.some((comment) => comment.text === "hi"));
});

test("DELETE /api/comments removes one, 404 for unknown, 400 for malformed", async () => {
	await addComments(gitDir, "working", [{ ...SAMPLE, start: 40, end: 40 }]);
	const target = (await readComments(gitDir)).find((comment) => comment.start === 40)!;
	assert.equal((await get(`/api/comments?id=${target.id}`, undefined, running.port, "DELETE")).status, 204);
	assert.ok(!(await readComments(gitDir)).some((comment) => comment.id === target.id));
	const unknown = "00000000-0000-4000-8000-000000000000";
	assert.equal((await get(`/api/comments?id=${unknown}`, undefined, running.port, "DELETE")).status, 404);
	assert.equal((await get("/api/comments?id=nope", undefined, running.port, "DELETE")).status, 400);
	assert.equal((await get("/api/comments", undefined, running.port, "DELETE")).status, 400);
});

test("other methods and DELETE elsewhere get 405", async () => {
	assert.equal((await get("/api/comments", undefined, running.port, "POST")).status, 405);
	assert.equal((await get("/api/comments?id=x", undefined, running.port, "PUT")).status, 405);
	assert.equal((await get("/api/files?source=working", undefined, running.port, "DELETE")).status, 405);
});

test("foreign Host header gets 403 on DELETE too", async () => {
	const id = "00000000-0000-4000-8000-000000000000";
	assert.equal((await get(`/api/comments?id=${id}`, "evil.example.com", running.port, "DELETE")).status, 403);
});

test("a comment write sends event: comments on the event stream", async () => {
	const received = new Promise<string>((done, fail) => {
		const req = request({ host: "127.0.0.1", port: running.port, path: "/api/events" }, (res) => {
			res.on("data", (chunk: Buffer) => {
				if (chunk.toString().includes("event: comments")) {
					req.destroy();
					done(chunk.toString());
				}
			});
		});
		req.on("error", fail);
		req.end();
		setTimeout(() => addComments(gitDir, "working", [{ ...SAMPLE, start: 77, end: 77 }]), 100);
	});
	assert.match(await received, /event: comments\ndata: \{\}\n\n/);
});
