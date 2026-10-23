import { addComments, clearComments, readComments, removeComments } from "./comments.ts";
import type { Comment, CommentDraft, CommentMatch } from "./comments.ts";

export type CommentCommand =
	| { kind: "add"; source: string; anchor: Anchor; text: string }
	| { kind: "batch"; source: string }
	| { kind: "list"; source: string }
	| { kind: "remove"; source: string; match: CommentMatch }
	| { kind: "clear"; source: string | null };

type Anchor = Omit<CommentDraft, "text">;

const FLAGS = new Set(["--branch", "--old", "--batch", "--clear", "--all", "--list", "--remove"]);
const MODE_FLAGS = ["--batch", "--clear", "--list", "--remove"];
const MAX_LIST_TEXT_CHARS = 80;
const PR_PATTERN = /^\d{1,7}$/;
const LINES_PATTERN = /^(\d+)(?:-(\d+))?$/;
const MAX_TEXT_CHARS = 20_000;

export function parseCommentArgs(args: string[]): CommentCommand {
	const flags = new Set(args.filter((arg) => FLAGS.has(arg)));
	const positional = args.filter((arg) => !FLAGS.has(arg));
	if (MODE_FLAGS.filter((flag) => flags.has(flag)).length > 1)
		throw new Error(`use only one of ${MODE_FLAGS.join(", ")}`);
	if (flags.has("--all") && !flags.has("--clear")) throw new Error("--all only works with --clear");
	if (flags.has("--clear") && flags.has("--all")) return parseClearAll(flags, positional);
	if (flags.has("--remove")) return parseRemove(flags, positional);
	if (MODE_FLAGS.some((flag) => flags.has(flag))) return parseSourceOnly(flags, positional);
	return parseAdd(flags, positional);
}

export function parseBatch(input: string): CommentDraft[] {
	let items: unknown;
	try {
		items = JSON.parse(input);
	} catch {
		throw new Error("batch is not valid JSON");
	}
	if (!Array.isArray(items) || items.length === 0) throw new Error("batch must be a non-empty JSON array");
	return items.map((item, index) => {
		try {
			return parseBatchItem(item);
		} catch (error) {
			throw new Error(`item ${index}: ${(error as Error).message}`);
		}
	});
}

export async function runComment(command: CommentCommand, gitDir: string): Promise<string> {
	if (command.kind === "clear") return runClear(command.source, gitDir);
	if (command.kind === "list") return runList(command.source, gitDir);
	if (command.kind === "remove") return runRemove(command.source, command.match, gitDir);
	if (command.kind === "batch") return runBatch(command.source, gitDir);
	const text = parseText(command.text === "-" ? await readStdin() : command.text);
	const [result] = await addComments(gitDir, command.source, [{ ...command.anchor, text }]);
	return `comment ${result}: ${command.source} ${command.anchor.path}:${formatLines(command.anchor)}`;
}

function parseClearAll(flags: Set<string>, positional: string[]): CommentCommand {
	if (positional.length > 0 || flags.has("--branch") || flags.has("--old"))
		throw new Error("--clear --all takes no other arguments");
	return { kind: "clear", source: null };
}

function parseSourceOnly(flags: Set<string>, positional: string[]): CommentCommand {
	if (positional.length > 1) throw new Error("too many arguments");
	if (flags.has("--old")) throw new Error("--old only works with a single comment");
	const source = parseSource(flags, positional[0]);
	if (flags.has("--list")) return { kind: "list", source };
	return flags.has("--batch") ? { kind: "batch", source } : { kind: "clear", source };
}

function parseRemove(flags: Set<string>, positional: string[]): CommentCommand {
	if (positional.length < 1 || positional.length > 2) throw new Error("expected <path>[:<line>[-<end>]]");
	const source = parseSource(flags, positional.length === 2 ? positional[0] : undefined);
	const target = positional[positional.length - 1];
	const split = target.lastIndexOf(":");
	if (split === -1 || !LINES_PATTERN.test(target.slice(split + 1))) {
		const path = parsePath(target);
		return { kind: "remove", source, match: flags.has("--old") ? { path, side: "old" } : { path } };
	}
	const { path, side, start, end } = parseAnchor(target.slice(0, split), target.slice(split + 1), flags.has("--old"));
	return { kind: "remove", source, match: { path, side, start, end } };
}

function parseAdd(flags: Set<string>, positional: string[]): CommentCommand {
	if (positional.length < 2 || positional.length > 3) throw new Error("expected <path>:<line>[-<end>] <text>");
	const source = parseSource(flags, positional.length === 3 ? positional[0] : undefined);
	const [target, text] = positional.slice(-2);
	const split = target.lastIndexOf(":");
	if (split === -1) throw new Error(`expected <path>:<line>[-<end>], got ${target}`);
	const anchor = parseAnchor(target.slice(0, split), target.slice(split + 1), flags.has("--old"));
	if (text !== "-") parseText(text);
	return { kind: "add", source, anchor, text };
}

function parseSource(flags: Set<string>, pr: string | undefined): string {
	if (flags.has("--branch") && pr !== undefined) throw new Error("use either --branch or a PR number, not both");
	if (pr !== undefined) {
		if (!PR_PATTERN.test(pr)) throw new Error(`bad PR number: ${pr}`);
		return `pr-${Number(pr)}`;
	}
	return flags.has("--branch") ? "branch" : "working";
}

function parseBatchItem(item: unknown): CommentDraft {
	if (typeof item !== "object" || item === null) throw new Error("must be an object");
	const { path, lines, old, text } = item as Record<string, unknown>;
	if (typeof path !== "string") throw new Error("path must be a string");
	if (typeof lines !== "string") throw new Error('lines must be a string like "7" or "7-10"');
	if (old !== undefined && typeof old !== "boolean") throw new Error("old must be true or false");
	if (typeof text !== "string") throw new Error("text must be a string");
	return { ...parseAnchor(path, lines, old === true), text: parseText(text) };
}

function parsePath(rawPath: string): string {
	const path = rawPath.startsWith("./") ? rawPath.slice(2) : rawPath;
	if (path === "") throw new Error("path is empty");
	if (path.startsWith("/")) throw new Error(`path must be relative: ${path}`);
	if (path.split("/").includes("..")) throw new Error(`path must not contain "..": ${path}`);
	return path;
}

function parseAnchor(rawPath: string, lines: string, old: boolean): Anchor {
	const path = parsePath(rawPath);
	const match = LINES_PATTERN.exec(lines);
	if (!match) throw new Error(`bad lines: ${lines}`);
	const start = Number(match[1]);
	const end = match[2] === undefined ? start : Number(match[2]);
	if (start < 1) throw new Error(`lines start at 1: ${lines}`);
	if (end < start) throw new Error(`end is before start: ${lines}`);
	return { path, side: old ? "old" : "new", start, end };
}

function parseText(raw: string): string {
	const text = raw.trim();
	if (text === "") throw new Error("text is empty");
	if (text.length > MAX_TEXT_CHARS) throw new Error(`text is longer than ${MAX_TEXT_CHARS} characters`);
	return text;
}

async function runList(source: string, gitDir: string): Promise<string> {
	const comments = (await readComments(gitDir)).filter((comment) => comment.source === source);
	if (comments.length === 0) return `no comments: ${source}`;
	return comments.map(formatListLine).join("\n");
}

function formatListLine(comment: Comment): string {
	const side = comment.side === "old" ? " (old)" : "";
	const firstLine = comment.text.split("\n")[0].slice(0, MAX_LIST_TEXT_CHARS);
	return `${comment.path}:${formatLines(comment)}${side}  ${firstLine}`;
}

async function runRemove(source: string, match: CommentMatch, gitDir: string): Promise<string> {
	const lines =
		match.start === undefined || match.end === undefined
			? ""
			: `:${formatLines({ start: match.start, end: match.end })}`;
	const target = `${match.path}${lines}`;
	const removed = await removeComments(gitDir, source, match);
	if (removed === 0) throw new Error(`no comment matches ${target}`);
	return `removed ${removed} comments: ${source} ${target}`;
}

async function runBatch(source: string, gitDir: string): Promise<string> {
	const drafts = parseBatch(await readStdin());
	await addComments(gitDir, source, drafts);
	return `${drafts.length} comments added: ${source}`;
}

async function runClear(source: string | null, gitDir: string): Promise<string> {
	const removed = await clearComments(gitDir, source);
	return `cleared ${removed} comments: ${source ?? "all"}`;
}

function formatLines({ start, end }: { start: number; end: number }): string {
	return start === end ? String(start) : `${start}-${end}`;
}

async function readStdin(): Promise<string> {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	return input;
}
