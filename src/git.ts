import { execFile } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { addWordDiffs, parseHunks } from "./shared/diff.ts";
import type { Chunk } from "./shared/diff.ts";

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface ChangedFile {
	path: string;
	oldPath?: string;
	status: FileStatus;
}

export interface PrInfo {
	number: number;
	title: string;
	author: string;
	url: string;
}

export interface ResolvedSource {
	oldRef: string;
	newRef: string | null;
	files: ChangedFile[];
	pr?: PrInfo;
	commitCount?: number;
}

export interface Pr {
	number: number;
	title: string;
	author: string;
	updatedAt: string;
	isDraft: boolean;
}

export interface Sources {
	repo: string;
	branch: string;
	defaultBranch: string | null;
	working: { fileCount: number };
	branchView: { commitCount: number; fileCount: number } | { error: string };
	prs: Pr[];
	prError?: string;
}

interface FileHead {
	path: string;
	oldPath: string;
	status: FileStatus;
}

export type FileDetail =
	| (FileHead & { binary: true })
	| (FileHead & { tooLarge: { oldLines: number; newLines: number } })
	| (FileHead & { oldText: string; newText: string; chunks: Chunk[] });

interface GhPrView {
	number: number;
	title: string;
	author: { login: string };
	url: string;
	baseRefName: string;
	headRefOid: string;
}

interface GhPrListItem {
	number: number;
	title: string;
	author: { login: string };
	updatedAt: string;
	isDraft: boolean;
}

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 512 * 1024 * 1024;
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv"];
const BINARY_SNIFF_CHARS = 8192;
// ponytail: 1 MB / 20k lines ceiling, no virtual scrolling in the page yet
const MAX_FILE_CHARS = 1024 * 1024;
const MAX_FILE_LINES = 20000;
const STATUS_BY_CODE: Record<string, FileStatus> = { A: "added", M: "modified", D: "deleted", R: "renamed" };

async function run(command: string, args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync(command, args, { cwd, maxBuffer: MAX_BUFFER, encoding: "utf8" });
	return stdout;
}

function git(root: string, args: string[]): Promise<string> {
	return run("git", ["--literal-pathspecs", ...args], root);
}

async function tryGit(root: string, args: string[]): Promise<string | null> {
	try {
		return await git(root, args);
	} catch {
		return null;
	}
}

export async function findRepoRoot(cwd: string): Promise<string | null> {
	const output = await tryGit(cwd, ["rev-parse", "--show-toplevel"]);
	return output === null ? null : output.trim();
}

export async function findGitDir(cwd: string): Promise<string | null> {
	const output = await tryGit(cwd, ["rev-parse", "--absolute-git-dir"]);
	return output === null ? null : output.trim();
}

export async function resolveSource(root: string, source: string): Promise<ResolvedSource> {
	if (source === "working") return resolveWorking(root);
	if (source === "branch") return resolveBranch(root);
	return resolvePr(root, Number(source.slice("pr-".length)));
}

export async function readSources(root: string): Promise<Sources> {
	const prs = listOpenPrs(root);
	const target = await findTargetBranch(root);
	return {
		repo: basename(root),
		branch: (await git(root, ["branch", "--show-current"])).trim(),
		defaultBranch: target === null ? null : target.replace(/^origin\//, ""),
		working: { fileCount: (await resolveWorking(root)).files.length },
		branchView: await summarizeBranch(root),
		...(await prs)
	};
}

export async function readFileDetail(root: string, source: ResolvedSource, file: ChangedFile): Promise<FileDetail> {
	const head: FileHead = { path: file.path, oldPath: file.oldPath ?? file.path, status: file.status };
	const oldText = file.status === "added" ? "" : await git(root, ["show", `${source.oldRef}:${head.oldPath}`]);
	const newText = await readNewText(root, source, file);
	if (isBinary(oldText) || isBinary(newText)) return { ...head, binary: true };
	const oldLines = countLines(oldText);
	const newLines = countLines(newText);
	if (isTooLarge(oldText, oldLines) || isTooLarge(newText, newLines))
		return { ...head, tooLarge: { oldLines, newLines } };
	const chunks = await readChunks(root, source, head, oldLines, newLines);
	return { ...head, oldText, newText, chunks: addWordDiffs(chunks, oldText, newText) };
}

async function resolveWorking(root: string): Promise<ResolvedSource> {
	const tracked = parseNameStatus(await git(root, ["diff", ...DIFF_FLAGS, "--name-status", "-z", "-M", "HEAD"]));
	const untrackedOutput = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
	const untracked = untrackedOutput
		.split("\0")
		.filter((path) => path !== "")
		.map((path): ChangedFile => ({ path, status: "added" }));
	return { oldRef: "HEAD", newRef: null, files: [...tracked, ...untracked] };
}

async function resolveBranch(root: string): Promise<ResolvedSource> {
	const target = await findTargetBranch(root);
	if (target === null) throw new Error("no origin/HEAD, origin/main or origin/master to compare with");
	const head = (await git(root, ["rev-parse", "HEAD"])).trim();
	const range = await resolveRange(root, target, head);
	const commitCount = Number(await git(root, ["rev-list", "--count", `${range.oldRef}..${head}`]));
	return { ...range, commitCount };
}

async function resolvePr(root: string, number: number): Promise<ResolvedSource> {
	const view = JSON.parse(
		await run("gh", ["pr", "view", String(number), "--json", "number,title,author,url,baseRefName,headRefOid"], root)
	) as GhPrView;
	await git(root, ["fetch", "--no-tags", "origin", `refs/pull/${number}/head`, view.baseRefName]);
	const range = await resolveRange(root, `origin/${view.baseRefName}`, view.headRefOid);
	return { ...range, pr: { number: view.number, title: view.title, author: view.author.login, url: view.url } };
}

async function resolveRange(root: string, target: string, head: string): Promise<ResolvedSource> {
	const base = (await git(root, ["merge-base", target, head])).trim();
	if (base === head) return { oldRef: base, newRef: head, files: [] };
	const output = await git(root, ["diff", ...DIFF_FLAGS, "--name-status", "-z", "-M", base, head]);
	return { oldRef: base, newRef: head, files: parseNameStatus(output) };
}

async function findTargetBranch(root: string): Promise<string | null> {
	const originHead = await tryGit(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	if (originHead !== null) return originHead.trim();
	for (const candidate of ["origin/main", "origin/master"]) {
		if ((await tryGit(root, ["rev-parse", "--verify", "--quiet", candidate])) !== null) return candidate;
	}
	return null;
}

async function summarizeBranch(root: string): Promise<Sources["branchView"]> {
	try {
		const branch = await resolveBranch(root);
		return { commitCount: branch.commitCount ?? 0, fileCount: branch.files.length };
	} catch (error) {
		return { error: errorMessage(error) };
	}
}

async function listOpenPrs(root: string): Promise<{ prs: Pr[]; prError?: string }> {
	try {
		const output = await run(
			"gh",
			["pr", "list", "--state", "open", "--limit", "50", "--json", "number,title,author,updatedAt,isDraft"],
			root
		);
		const items = JSON.parse(output) as GhPrListItem[];
		const prs = items.map((item): Pr => ({
			number: item.number,
			title: item.title,
			author: item.author.login,
			updatedAt: item.updatedAt,
			isDraft: item.isDraft
		}));
		return { prs: prs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
	} catch (error) {
		return { prs: [], prError: errorMessage(error) };
	}
}

function parseNameStatus(output: string): ChangedFile[] {
	const parts = output.split("\0");
	const files: ChangedFile[] = [];
	let index = 0;
	while (index < parts.length && parts[index] !== "") {
		const code = parts[index++];
		if (code.startsWith("R")) {
			const oldPath = parts[index++];
			files.push({ path: parts[index++], oldPath, status: "renamed" });
		} else {
			files.push({ path: parts[index++], status: STATUS_BY_CODE[code[0]] ?? "modified" });
		}
	}
	return files;
}

async function readNewText(root: string, source: ResolvedSource, file: ChangedFile): Promise<string> {
	if (file.status === "deleted") return "";
	if (source.newRef === null) return readFromDisk(join(root, file.path));
	return git(root, ["show", `${source.newRef}:${file.path}`]);
}

async function readFromDisk(path: string): Promise<string> {
	if ((await lstat(path)).isSymbolicLink()) return readlink(path);
	return readFile(path, "utf8");
}

async function readChunks(
	root: string,
	source: ResolvedSource,
	file: FileHead,
	oldLines: number,
	newLines: number
): Promise<Chunk[]> {
	if (file.status === "added") return wholeFileChunk("added", newLines);
	if (file.status === "deleted") return wholeFileChunk("deleted", oldLines);
	const revs = source.newRef === null ? [source.oldRef] : [source.oldRef, source.newRef];
	const paths = [...new Set([file.oldPath, file.path])];
	const output = await git(root, ["diff", ...DIFF_FLAGS, "-U0", "-M", ...revs, "--", ...paths]);
	return parseHunks(output);
}

function wholeFileChunk(kind: "added" | "deleted", lines: number): Chunk[] {
	if (lines === 0) return [];
	if (kind === "added") return [{ kind, oldStart: 0, oldEnd: 0, newStart: 0, newEnd: lines }];
	return [{ kind, oldStart: 0, oldEnd: lines, newStart: 0, newEnd: 0 }];
}

function isBinary(text: string): boolean {
	return text.slice(0, BINARY_SNIFF_CHARS).includes("\0");
}

function isTooLarge(text: string, lines: number): boolean {
	return text.length > MAX_FILE_CHARS || lines > MAX_FILE_LINES;
}

function countLines(text: string): number {
	if (text === "") return 0;
	const parts = text.split("\n").length;
	return text.endsWith("\n") ? parts - 1 : parts;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
