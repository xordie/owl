import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import { makeTempDir } from "./helpers.ts";

const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

function runCli(cwd: string, ...args: string[]) {
	return spawnSync("node", ["--disable-warning=ExperimentalWarning", CLI, ...args], { cwd, encoding: "utf8" });
}

test("outside a git repo exits 1 with the message", () => {
	const actual = runCli(makeTempDir(), "--no-open");
	assert.equal(actual.status, 1);
	assert.equal(actual.stderr, "owl: not a git repository\n");
});

test("unknown arguments print usage and exit 1", () => {
	const actual = runCli(makeTempDir(), "--nope");
	assert.equal(actual.status, 1);
	assert.match(actual.stderr, /^usage: owl/);
});

test("--help prints usage and exits 0", () => {
	const actual = runCli(makeTempDir(), "--help");
	assert.equal(actual.status, 0);
	assert.match(actual.stdout, /^usage: owl/);
});

test("runs from inside node_modules, where Node refuses to strip types", () => {
	const root = join(import.meta.dirname, "..");
	const installed = join(makeTempDir(), "node_modules", "owl");
	mkdirSync(installed, { recursive: true });
	for (const name of ["bin", "src", "package.json"])
		cpSync(join(root, name), join(installed, name), { recursive: true });
	const actual = spawnSync("node", [join(installed, "bin", "owl.js"), "--help"], {
		cwd: makeTempDir(),
		encoding: "utf8"
	});
	assert.equal(actual.status, 0);
	assert.match(actual.stdout, /^usage: owl/);
});
