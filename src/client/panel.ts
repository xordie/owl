import type { ChangedFile, FileDetail, Pr, PrInfo, Sources } from "../git.ts";
import type { TreeNode } from "../shared/tree.ts";

export interface HeaderInfo {
	detail: FileDetail | null;
	pr: PrInfo | undefined;
	changeIndex: number;
	changeCount: number;
	fileIndex: number;
	fileCount: number;
}

export interface TreeHandlers {
	onFile: (path: string) => void;
	onToggle: (folderPath: string) => void;
}

const INDENT_PX = 14;

export function sourceIds(sources: Sources): string[] {
	return ["working", "branch", ...sources.prs.map((pr) => `pr-${pr.number}`)];
}

export function renderSources(
	container: HTMLElement,
	sources: Sources | null,
	error: string | null,
	selected: string,
	onSelect: (id: string) => void
): void {
	if (!sources) return container.replaceChildren(element("div", "item muted", error ?? "Loading..."));
	const items = [
		repoRow(sources),
		element("div", "heading", "Local"),
		sourceItem("working", "Working changes", `${sources.working.fileCount} files`),
		sourceItem("branch", `Branch vs ${sources.defaultBranch ?? "?"}`, branchSummary(sources)),
		element("div", "heading", "Open PRs"),
		...(sources.prError ? [element("div", "item muted", sources.prError)] : sources.prs.map(prItem))
	];
	for (const item of items) if (item.dataset.source) item.onclick = () => onSelect(item.dataset.source ?? "");
	for (const item of items) item.classList.toggle("selected", item.dataset.source === selected);
	container.replaceChildren(...items);
}

export function renderTree(
	container: HTMLElement,
	nodes: TreeNode<ChangedFile>[],
	selectedPath: string | null,
	collapsed: Set<string>,
	commentCounts: ReadonlyMap<string, number>,
	handlers: TreeHandlers,
	emptyText: string
): void {
	if (nodes.length === 0) return container.replaceChildren(element("div", "item muted", emptyText));
	const rows: HTMLElement[] = [];
	appendRows(rows, nodes, 0, selectedPath, collapsed, commentCounts, handlers);
	container.replaceChildren(...rows);
	container.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

export function renderHeader(container: HTMLElement, info: HeaderInfo): void {
	const { detail, pr } = info;
	const lines: HTMLElement[] = [];
	if (detail) lines.push(pathLine(detail, info));
	if (pr) lines.push(prLine(pr));
	container.replaceChildren(...lines);
}

export function formatAge(isoDate: string, now: number = Date.now()): string {
	const minutes = Math.max(0, Math.floor((now - Date.parse(isoDate)) / 60_000));
	if (minutes < 60) return `${minutes}m`;
	if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
	return `${Math.floor(minutes / (60 * 24))}d`;
}

function element(tag: "div" | "span" | "a" | "strong", className: string, text = ""): HTMLElement {
	const created = document.createElement(tag);
	created.className = className;
	created.textContent = text;
	return created;
}

function repoRow(sources: Sources): HTMLElement {
	const row = element("div", "repo");
	row.append(element("strong", "", sources.repo), element("span", "muted", ` · ${sources.branch}`));
	return row;
}

function sourceItem(id: string, title: string, summary: string): HTMLElement {
	const item = element("div", "item");
	item.dataset.source = id;
	item.append(element("div", "title", title), element("div", "meta", summary));
	return item;
}

function branchSummary(sources: Sources): string {
	if ("error" in sources.branchView) return sources.branchView.error;
	if (sources.branch === sources.defaultBranch) return "on default branch";
	const { commitCount, fileCount } = sources.branchView;
	return `${commitCount} commits, ${fileCount} files`;
}

function prItem(pr: Pr): HTMLElement {
	const item = element("div", "item");
	item.dataset.source = `pr-${pr.number}`;
	const meta = element("div", "meta", `${pr.author} · ${formatAge(pr.updatedAt)}`);
	if (pr.isDraft) meta.append(element("span", "tag", "draft"));
	item.append(element("div", "title", `#${pr.number} ${pr.title}`), meta);
	return item;
}

function appendRows(
	rows: HTMLElement[],
	nodes: TreeNode<ChangedFile>[],
	depth: number,
	selectedPath: string | null,
	collapsed: Set<string>,
	commentCounts: ReadonlyMap<string, number>,
	handlers: TreeHandlers
): void {
	for (const node of nodes) {
		if (node.kind === "file") {
			rows.push(fileRow(node.name, node.file, depth, node.file.path === selectedPath, commentCounts, handlers));
			continue;
		}
		const isCollapsed = collapsed.has(node.path);
		rows.push(folderRow(node.name, node.path, depth, isCollapsed, handlers));
		if (!isCollapsed) appendRows(rows, node.children, depth + 1, selectedPath, collapsed, commentCounts, handlers);
	}
}

function fileRow(
	name: string,
	file: ChangedFile,
	depth: number,
	selected: boolean,
	commentCounts: ReadonlyMap<string, number>,
	handlers: TreeHandlers
): HTMLElement {
	const row = element("div", `row-tree status-${file.status}${selected ? " selected" : ""}`, name);
	row.style.paddingLeft = `${8 + depth * INDENT_PX + INDENT_PX}px`;
	row.title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
	const count = commentCounts.get(file.path);
	if (count) row.append(element("span", "comment-count", String(count)));
	row.onclick = () => handlers.onFile(file.path);
	return row;
}

function folderRow(
	name: string,
	path: string,
	depth: number,
	isCollapsed: boolean,
	handlers: TreeHandlers
): HTMLElement {
	const row = element("div", "row-tree folder-row", `${isCollapsed ? "▸" : "▾"} ${name}`);
	row.style.paddingLeft = `${8 + depth * INDENT_PX}px`;
	row.onclick = () => handlers.onToggle(path);
	return row;
}

function pathLine(detail: FileDetail, info: HeaderInfo): HTMLElement {
	const line = element("div", "");
	const renamed = detail.oldPath !== detail.path;
	const position = `change ${info.changeIndex < 0 ? "–" : info.changeIndex + 1} of ${info.changeCount} · file ${info.fileIndex + 1} of ${info.fileCount}`;
	line.append(
		element("span", "info", position),
		element("span", `path status-${detail.status}`, renamed ? `${detail.oldPath} → ${detail.path}` : detail.path)
	);
	return line;
}

function prLine(pr: PrInfo): HTMLElement {
	const line = element("div", "muted", `#${pr.number} ${pr.title} · ${pr.author} · `);
	const link = element("a", "", "GitHub") as HTMLAnchorElement;
	link.href = pr.url;
	link.target = "_blank";
	link.rel = "noopener";
	line.append(link);
	return line;
}
