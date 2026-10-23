import type { Comment } from "../comments.ts";
import type { ChangedFile, FileDetail, PrInfo, Sources } from "../git.ts";
import { commentForChunk, countByPath, nextCommentIndex } from "../shared/comment-layout.ts";
import { buildTree, treeFiles } from "../shared/tree.ts";
import { createCommentLayer } from "./comments.ts";
import { createDiffView } from "./diff-view.ts";
import type { ScrollPosition } from "./diff-view.ts";
import { setupResize } from "./resize.ts";
import { renderHeader, renderSources, renderTree, sourceIds } from "./panel.ts";

interface ApiError {
	error: string;
}

interface FilesResponse {
	files: ChangedFile[];
	pr?: PrInfo;
}

interface OpenOptions {
	startAt?: "first" | "last";
	restore?: ScrollPosition;
}

function byId<T extends HTMLElement>(id: string): T {
	const found = document.getElementById(id);
	if (!found) throw new Error(`missing #${id}`);
	return found as T;
}

const sourcesEl = byId("sources");
const treeEl = byId("tree");
const filterEl = byId<HTMLInputElement>("filter");
const headerEl = byId("header");
const helpEl = byId("help");

const view = createDiffView(
	{
		panes: byId("panes"),
		note: byId("note"),
		oldScroller: byId("oldPane"),
		newScroller: byId("newPane"),
		strip: byId("strip") as unknown as SVGSVGElement
	},
	() => drawHeader()
);

setupResize({
	left: byId("left"),
	sources: sourcesEl,
	leftHandle: byId("leftHandle"),
	splitHandle: byId("splitHandle"),
	oldPane: byId("oldPane"),
	newPane: byId("newPane"),
	strip: byId("strip") as unknown as SVGSVGElement
});

const commentLayer = createCommentLayer({
	panes: byId("panes"),
	scrollers: { old: byId("oldPane"), new: byId("newPane") }
});

let sources: Sources | null = null;
let sourcesError: string | null = null;
let source = "working";
let files: ChangedFile[] = [];
let pr: PrInfo | undefined;
let filesError: string | null = null;
let selectedPath: string | null = null;
let currentDetail: FileDetail | null = null;
let filterText: string | null = null;
let comments: Comment[] = [];
let commentIndex = -1;
let generation = 0;
const collapsed = new Set<string>();

async function getJson<T>(url: string): Promise<T | ApiError> {
	try {
		return (await (await fetch(url)).json()) as T | ApiError;
	} catch (error) {
		return { error: String(error) };
	}
}

function isError<T>(response: T | ApiError): response is ApiError {
	return typeof response === "object" && response !== null && "error" in response;
}

async function loadSources(): Promise<void> {
	const response = await getJson<Sources>("/api/sources");
	sources = isError(response) ? null : response;
	sourcesError = isError(response) ? response.error : null;
	drawSources();
}

async function loadComments(): Promise<void> {
	const response = await getJson<{ comments: Comment[] }>("/api/comments");
	comments = isError(response) ? [] : response.comments;
	drawTree();
	drawComments();
}

function sourceComments(): Comment[] {
	return comments.filter((comment) => comment.source === source);
}

function drawComments(): void {
	commentLayer.render(sourceComments().filter((comment) => comment.path === selectedPath));
}

function focusChangeComment(): void {
	const chunk = view.currentChunk();
	const inFile = sourceComments().filter((comment) => comment.path === selectedPath);
	commentLayer.focus((chunk && commentForChunk(inFile, chunk)?.id) ?? null);
}

async function goToComment(direction: 1 | -1): Promise<void> {
	const list = sourceComments();
	const hasFile = (comment: Comment): boolean => files.some((file) => file.path === comment.path);
	const index = nextCommentIndex(list, commentIndex, direction, hasFile);
	if (index === commentIndex) return;
	commentIndex = index;
	const target = list[index];
	if (target.path !== selectedPath) await openFile(target.path);
	if (target.path !== selectedPath) return;
	commentLayer.reveal(target.id);
	view.goToLine(target.side, target.start);
}

async function loadFiles(force = false): Promise<void> {
	const response = await getJson<FilesResponse>(`/api/files?source=${source}${force ? "&refresh=1" : ""}`);
	files = isError(response) ? [] : response.files;
	pr = isError(response) ? undefined : response.pr;
	filesError = isError(response) ? response.error : null;
	drawSources();
	drawTree();
}

async function selectSource(id: string, preferredPath?: string): Promise<void> {
	const mine = ++generation;
	source = id;
	selectedPath = null;
	commentIndex = -1;
	await loadFiles();
	if (mine !== generation) return;
	await openFirstOrPreferred(preferredPath);
}

async function openFirstOrPreferred(preferredPath?: string): Promise<void> {
	const target = files.find((file) => file.path === preferredPath) ?? files[0];
	if (target) return openFile(target.path);
	selectedPath = null;
	currentDetail = null;
	view.showMessage(filesError ?? "No changes.");
	drawComments();
	writeHash();
	drawHeader();
}

async function openFile(path: string, options: OpenOptions = {}): Promise<void> {
	const mine = ++generation;
	selectedPath = path;
	expandAncestors(path);
	drawTree();
	writeHash();
	const detail = await getJson<FileDetail>(`/api/file?source=${source}&path=${encodeURIComponent(path)}`);
	if (mine !== generation) return;
	if (isError(detail)) {
		currentDetail = null;
		view.showMessage(detail.error);
	} else {
		currentDetail = detail;
		view.showFile(detail, options.restore);
		if (options.startAt === "first") view.goToChange(0);
		if (options.startAt === "last") view.goToChange(view.changeCount() - 1);
	}
	drawComments();
	if (options.startAt) focusChangeComment();
	drawHeader();
}

async function refresh(forceFiles: boolean): Promise<void> {
	void loadComments();
	await loadSources();
	const mine = ++generation;
	if (forceFiles || source === "working" || source === "branch") await loadFiles(forceFiles);
	if (mine !== generation) return;
	const stillThere = files.some((file) => file.path === selectedPath);
	if (!stillThere) return openFirstOrPreferred();
	await openFile(selectedPath ?? "", { restore: view.scrollPosition() });
}

function orderedFiles(): ChangedFile[] {
	return treeFiles(buildTree(files));
}

function matchingFiles(): ChangedFile[] {
	if (!filterText) return files;
	const needle = filterText.toLowerCase();
	return files.filter((file) => file.path.toLowerCase().includes(needle));
}

function expandAncestors(path: string): void {
	for (const folder of collapsed) if (path.startsWith(`${folder}/`)) collapsed.delete(folder);
}

function writeHash(): void {
	const params = new URLSearchParams({ source });
	if (selectedPath) params.set("file", selectedPath);
	history.replaceState(null, "", `#${params}`);
}

function drawSources(): void {
	renderSources(sourcesEl, sources, sourcesError, source, (id) => void selectSource(id));
}

function drawTree(): void {
	const emptyText = filesError ?? (filterText ? "No matching files." : "No changes.");
	const handlers = {
		onFile: (path: string) => void openFile(path),
		onToggle: (folder: string) => {
			if (!collapsed.delete(folder)) collapsed.add(folder);
			drawTree();
		}
	};
	renderTree(
		treeEl,
		buildTree(matchingFiles()),
		selectedPath,
		collapsed,
		countByPath(comments, source),
		handlers,
		emptyText
	);
}

function drawHeader(): void {
	renderHeader(headerEl, {
		detail: currentDetail,
		pr,
		changeIndex: view.currentChange(),
		changeCount: view.changeCount(),
		fileIndex: orderedFiles().findIndex((file) => file.path === selectedPath),
		fileCount: files.length
	});
}

function stepChange(direction: 1 | -1): void {
	const next = view.currentChange() + direction;
	if (next >= 0 && next < view.changeCount()) {
		view.goToChange(next);
		return focusChangeComment();
	}
	moveFile(direction, direction === 1 ? "first" : "last");
}

function moveFile(direction: 1 | -1, startAt?: "first" | "last"): void {
	const ordered = orderedFiles();
	const index = ordered.findIndex((file) => file.path === selectedPath);
	const next = ordered[index + direction];
	if (next) void openFile(next.path, { startAt });
}

function moveSource(direction: 1 | -1): void {
	if (!sources) return;
	const ids = sourceIds(sources);
	const next = ids[ids.indexOf(source) + direction];
	if (next) void selectSource(next);
}

function openFilter(): void {
	filterText = "";
	filterEl.value = "";
	filterEl.hidden = false;
	filterEl.focus();
	drawTree();
}

function closeFilter(): void {
	filterText = null;
	filterEl.hidden = true;
	filterEl.blur();
	drawTree();
}

function openFirstMatch(): void {
	const first = treeFiles(buildTree(matchingFiles()))[0];
	closeFilter();
	if (first) void openFile(first.path);
}

function toggleHelp(): void {
	helpEl.hidden = !helpEl.hidden;
}

function closeHelp(): void {
	helpEl.hidden = true;
}

const KEY_ACTIONS: Record<string, () => void> = {
	"n": () => stepChange(1),
	"F7": () => stepChange(1),
	"p": () => stepChange(-1),
	"Shift+F7": () => stepChange(-1),
	"j": () => moveFile(1),
	"k": () => moveFile(-1),
	"J": () => moveSource(1),
	"K": () => moveSource(-1),
	"c": () => commentLayer.toggleCards(),
	"v": () => commentLayer.toggleStyle(),
	"]": () => void goToComment(1),
	"[": () => void goToComment(-1),
	"/": openFilter,
	"r": () => void refresh(true),
	"?": toggleHelp,
	"Escape": closeHelp
};

document.addEventListener("keydown", (event) => {
	if (event.ctrlKey || event.metaKey || event.altKey || event.target === filterEl) return;
	const name = event.shiftKey && event.key === "F7" ? "Shift+F7" : event.key;
	if (!helpEl.hidden && name !== "?" && name !== "Escape") return;
	const action = KEY_ACTIONS[name];
	if (!action) return;
	event.preventDefault();
	action();
});

filterEl.addEventListener("keydown", (event) => {
	if (event.key === "Enter") openFirstMatch();
	if (event.key === "Escape") closeFilter();
});

filterEl.addEventListener("input", () => {
	filterText = filterEl.value;
	drawTree();
});

window.addEventListener("focus", () => void refresh(false));

async function start(): Promise<void> {
	const params = new URLSearchParams(location.hash.slice(1));
	await Promise.all([loadSources(), loadComments()]);
	await selectSource(params.get("source") ?? "working", params.get("file") ?? undefined);
}

const events = new EventSource("/api/events");
events.addEventListener("comments", () => void loadComments());
void start();
