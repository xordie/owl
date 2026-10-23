#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { spawn } from "node:child_process";
import { parseCommentArgs, runComment } from "./commentCommand.ts";
import { findGitDir, findRepoRoot } from "./git.ts";
import { startServer } from "./server.ts";

const USAGE = `usage: owl [--branch | <pr-number>] [--no-open]
       owl comment [--branch | <pr>] [--old] <path>:<line>[-<end>] <text | ->
       owl comment [--branch | <pr>] --batch      (JSON array on stdin)
       owl comment [--branch | <pr>] --list
       owl comment [--branch | <pr>] [--old] --remove <path>[:<line>[-<end>]]
       owl comment [--branch | <pr>] --clear
       owl comment --clear --all
`;

interface Options {
	source: string;
	open: boolean;
}

function parseArgs(args: string[]): Options | null {
	const open = !args.includes("--no-open");
	const rest = args.filter((arg) => arg !== "--no-open");
	if (rest.length === 0) return { source: "working", open };
	if (rest.length > 1) return null;
	if (rest[0] === "--branch") return { source: "branch", open };
	if (/^\d{1,7}$/.test(rest[0])) return { source: `pr-${Number(rest[0])}`, open };
	return null;
}

function openWindow(url: string): void {
	const launch = (command: string, args: string[], onError?: () => void): void => {
		const child = spawn(command, args, { detached: true, stdio: "ignore" });
		child.on("error", onError ?? (() => undefined));
		child.unref();
	};
	launch("google-chrome", [`--app=${url}`], () => launch("xdg-open", [url]));
}

function fail(message: string): never {
	process.stderr.write(message);
	process.exit(1);
}

async function runCommentCommand(args: string[]): Promise<void> {
	let command;
	try {
		command = parseCommentArgs(args);
	} catch (error) {
		fail(`owl: ${(error as Error).message}\n${USAGE}`);
	}
	const gitDir = await findGitDir(process.cwd());
	if (gitDir === null) fail("owl: not a git repository\n");
	try {
		process.stdout.write(`${await runComment(command, gitDir)}\n`);
	} catch (error) {
		fail(`owl: ${(error as Error).message}\n`);
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes("--help")) return void process.stdout.write(USAGE);
	if (args[0] === "comment") return runCommentCommand(args.slice(1));
	const options = parseArgs(args);
	if (options === null) {
		process.stderr.write(USAGE);
		process.exit(1);
	}
	const root = await findRepoRoot(process.cwd());
	if (root === null) {
		process.stderr.write("owl: not a git repository\n");
		process.exit(1);
	}
	const { port } = await startServer(root, () => process.exit(0));
	const url = `http://127.0.0.1:${port}/#source=${options.source}`;
	process.stdout.write(`${url}\n`);
	if (options.open) openWindow(url);
}

await main();
