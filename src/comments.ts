import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Comment {
	id: string;
	source: string;
	path: string;
	side: "old" | "new";
	start: number;
	end: number;
	text: string;
	createdAt: string;
}

export type CommentDraft = Omit<Comment, "id" | "source" | "createdAt">;

export interface CommentMatch {
	path: string;
	side?: "old" | "new";
	start?: number;
	end?: number;
}

export type AddResult = "added" | "replaced";

export const COMMENTS_DIR_NAME = "owl";
export const COMMENTS_FILE_NAME = "comments.json";

export function commentsDir(gitDir: string): string {
	return join(gitDir, COMMENTS_DIR_NAME);
}

export async function readComments(gitDir: string): Promise<Comment[]> {
	try {
		return JSON.parse(await readFile(join(commentsDir(gitDir), COMMENTS_FILE_NAME), "utf8")) as Comment[];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

export async function addComments(gitDir: string, source: string, drafts: CommentDraft[]): Promise<AddResult[]> {
	const comments = await readComments(gitDir);
	const results = drafts.map((draft) => upsert(comments, source, draft));
	await writeComments(gitDir, comments);
	return results;
}

export async function clearComments(gitDir: string, source: string | null): Promise<number> {
	const comments = await readComments(gitDir);
	const kept = source === null ? [] : comments.filter((comment) => comment.source !== source);
	const removed = comments.length - kept.length;
	if (removed > 0) await writeComments(gitDir, kept);
	return removed;
}

export async function removeComments(gitDir: string, source: string, match: CommentMatch): Promise<number> {
	const comments = await readComments(gitDir);
	const kept = comments.filter((comment) => !(comment.source === source && isMatch(comment, match)));
	const removed = comments.length - kept.length;
	if (removed > 0) await writeComments(gitDir, kept);
	return removed;
}

export async function deleteComment(gitDir: string, id: string): Promise<boolean> {
	const comments = await readComments(gitDir);
	const kept = comments.filter((comment) => comment.id !== id);
	if (kept.length === comments.length) return false;
	await writeComments(gitDir, kept);
	return true;
}

function upsert(comments: Comment[], source: string, draft: CommentDraft): AddResult {
	const createdAt = new Date().toISOString();
	const existing = comments.find((comment) => isSameAnchor(comment, source, draft));
	if (existing) {
		existing.text = draft.text;
		existing.createdAt = createdAt;
		return "replaced";
	}
	comments.push({ id: randomUUID(), source, createdAt, ...draft });
	return "added";
}

function isMatch(comment: Comment, match: CommentMatch): boolean {
	return (
		comment.path === match.path &&
		(match.side === undefined || comment.side === match.side) &&
		(match.start === undefined || comment.start === match.start) &&
		(match.end === undefined || comment.end === match.end)
	);
}

function isSameAnchor(comment: Comment, source: string, draft: CommentDraft): boolean {
	return (
		comment.source === source &&
		comment.path === draft.path &&
		comment.side === draft.side &&
		comment.start === draft.start &&
		comment.end === draft.end
	);
}

// ponytail: read-modify-write without a lock, so a CLI add racing a server delete can lose one write; add a lock file if it ever bites
async function writeComments(gitDir: string, comments: Comment[]): Promise<void> {
	const dir = commentsDir(gitDir);
	const temp = join(dir, `${COMMENTS_FILE_NAME}.${process.pid}.tmp`);
	await mkdir(dir, { recursive: true });
	await writeFile(temp, JSON.stringify(comments, null, "\t"));
	await rename(temp, join(dir, COMMENTS_FILE_NAME));
}
