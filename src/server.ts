import { watch } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { stripTypeScriptTypes } from "node:module";
import { extname, join, resolve, sep } from "node:path";
import { COMMENTS_FILE_NAME, commentsDir, deleteComment, readComments } from "./comments.ts";
import { findGitDir, readFileDetail, readSources, resolveSource } from "./git.ts";
import type { ResolvedSource } from "./git.ts";

export interface RunningServer {
	server: Server;
	port: number;
}

const SRC_DIR = import.meta.dirname;
const CLIENT_DIR = join(SRC_DIR, "client");
const SHARED_DIR = join(SRC_DIR, "shared");
const COMMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMENTS_DEBOUNCE_MS = 50;
const SOURCE_PATTERN = /^(working|branch|pr-\d{1,7})$/;
const NEVER_CONNECTED_MS = 60_000;
const ALL_CLOSED_MS = 5_000;
const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".svg": "image/svg+xml",
	".ts": "text/javascript; charset=utf-8"
};

interface Context {
	root: string;
	gitDir: string;
	sources: Map<string, ResolvedSource>;
	lifetime: Lifetime;
	streams: Set<ServerResponse>;
}

export async function startServer(root: string, onIdle: () => void): Promise<RunningServer> {
	const gitDir = await findGitDir(root);
	if (gitDir === null) throw new Error("not a git repository");
	const context: Context = { root, gitDir, sources: new Map(), lifetime: createLifetime(onIdle), streams: new Set() };
	let allowedHosts = new Set<string>();

	const server = createServer((req, res) => {
		if (!allowedHosts.has(req.headers.host ?? "")) return sendJson(res, 403, { error: "forbidden host" });
		route(req, res, context).catch((error: unknown) => sendJson(res, 500, { error: String(error) }));
	});
	const stopWatching = await watchComments(gitDir, context.streams);
	server.on("close", () => {
		context.lifetime.stop();
		stopWatching();
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as AddressInfo;
	allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
	return { server, port };
}

interface Lifetime {
	opened: () => void;
	closed: () => void;
	stop: () => void;
}

function createLifetime(onIdle: () => void): Lifetime {
	let openStreams = 0;
	let timer = setTimeout(onIdle, NEVER_CONNECTED_MS);
	return {
		opened() {
			openStreams++;
			clearTimeout(timer);
		},
		closed() {
			openStreams--;
			if (openStreams === 0) timer = setTimeout(() => openStreams === 0 && onIdle(), ALL_CLOSED_MS);
		},
		stop() {
			clearTimeout(timer);
		}
	};
}

async function watchComments(gitDir: string, streams: Set<ServerResponse>): Promise<() => void> {
	await mkdir(commentsDir(gitDir), { recursive: true });
	let timer: NodeJS.Timeout | undefined;
	const notify = (): void => {
		for (const stream of streams) stream.write("event: comments\ndata: {}\n\n");
	};
	const watcher = watch(commentsDir(gitDir), (_event, filename) => {
		if (filename !== COMMENTS_FILE_NAME) return;
		clearTimeout(timer);
		timer = setTimeout(notify, COMMENTS_DEBOUNCE_MS);
	});
	const stop = (): void => {
		clearTimeout(timer);
		watcher.close();
	};
	watcher.on("error", stop);
	return stop;
}

async function route(req: IncomingMessage, res: ServerResponse, context: Context): Promise<void> {
	const { root, sources } = context;
	const url = new URL(req.url ?? "/", "http://localhost");
	const pathname = decodePath(url.pathname);
	if (req.method === "DELETE" && pathname === "/api/comments") return removeComment(res, context.gitDir, url);
	if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
	if (pathname === null) return sendJson(res, 400, { error: "bad path" });
	if (pathname === "/") return sendStatic(res, join(CLIENT_DIR, "index.html"));
	if (pathname.startsWith("/client/")) return sendStatic(res, insideDir(CLIENT_DIR, pathname.slice("/client/".length)));
	if (pathname.startsWith("/shared/")) return sendStatic(res, insideDir(SHARED_DIR, pathname.slice("/shared/".length)));
	if (pathname === "/api/events") return openEventStream(req, res, context);
	if (pathname === "/api/comments") return sendJson(res, 200, { comments: await readComments(context.gitDir) });
	if (pathname === "/api/sources") return sendJson(res, 200, await readSources(root));
	if (pathname === "/api/files") return sendFiles(res, root, url, sources);
	if (pathname === "/api/file") return sendFile(res, root, url, sources);
	return sendJson(res, 404, { error: "not found" });
}

async function sendFiles(
	res: ServerResponse,
	root: string,
	url: URL,
	sources: Map<string, ResolvedSource>
): Promise<void> {
	const source = url.searchParams.get("source") ?? "";
	if (!SOURCE_PATTERN.test(source)) return sendJson(res, 400, { error: "bad source" });
	const cached = sources.get(source);
	if (cached && source.startsWith("pr-") && url.searchParams.get("refresh") !== "1") {
		return sendJson(res, 200, { files: cached.files, pr: cached.pr });
	}
	const resolved = await resolveSource(root, source);
	sources.set(source, resolved);
	sendJson(res, 200, { files: resolved.files, pr: resolved.pr });
}

async function sendFile(
	res: ServerResponse,
	root: string,
	url: URL,
	sources: Map<string, ResolvedSource>
): Promise<void> {
	const source = url.searchParams.get("source") ?? "";
	if (!SOURCE_PATTERN.test(source)) return sendJson(res, 400, { error: "bad source" });
	const resolved = sources.get(source);
	const file = resolved?.files.find((candidate) => candidate.path === url.searchParams.get("path"));
	if (!resolved || !file) return sendJson(res, 404, { error: "file not in the list for this source" });
	sendJson(res, 200, await readFileDetail(root, resolved, file));
}

async function removeComment(res: ServerResponse, gitDir: string, url: URL): Promise<void> {
	const id = url.searchParams.get("id") ?? "";
	if (!COMMENT_ID_PATTERN.test(id)) return sendJson(res, 400, { error: "bad id" });
	if (!(await deleteComment(gitDir, id))) return sendJson(res, 404, { error: "comment not found" });
	res.writeHead(204, { "cache-control": "no-store" });
	res.end();
}

function openEventStream(req: IncomingMessage, res: ServerResponse, { lifetime, streams }: Context): void {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "connection": "keep-alive" });
	res.write(":\n\n");
	lifetime.opened();
	streams.add(res);
	req.on("close", () => {
		streams.delete(res);
		lifetime.closed();
	});
}

async function sendStatic(res: ServerResponse, filePath: string | null): Promise<void> {
	const contentType = filePath === null ? undefined : CONTENT_TYPES[extname(filePath)];
	if (filePath === null || contentType === undefined) return sendJson(res, 404, { error: "not found" });
	try {
		const content = await readFile(filePath, "utf8");
		// ponytail: stripTypeScriptTypes is experimental in Node 24, add a one-line tsc build if it breaks
		const body = filePath.endsWith(".ts") ? stripTypeScriptTypes(content) : content;
		res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
		res.end(body);
	} catch {
		sendJson(res, 404, { error: "not found" });
	}
}

function insideDir(dir: string, relativePath: string): string | null {
	const target = resolve(dir, relativePath);
	return target.startsWith(dir + sep) ? target : null;
}

function decodePath(pathname: string): string | null {
	try {
		return decodeURIComponent(pathname);
	} catch {
		return null;
	}
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}
