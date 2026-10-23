export interface FolderNode<T> {
	kind: "folder";
	name: string;
	path: string;
	children: TreeNode<T>[];
}

export interface FileNode<T> {
	kind: "file";
	name: string;
	file: T;
}

export type TreeNode<T> = FolderNode<T> | FileNode<T>;

export function buildTree<T extends { path: string }>(files: T[]): TreeNode<T>[] {
	const root: FolderNode<T> = { kind: "folder", name: "", path: "", children: [] };
	for (const file of files) insertFile(root, file);
	return finishNodes(root.children);
}

export function treeFiles<T>(nodes: TreeNode<T>[]): T[] {
	return nodes.flatMap((node) => (node.kind === "file" ? [node.file] : treeFiles(node.children)));
}

function insertFile<T extends { path: string }>(root: FolderNode<T>, file: T): void {
	const parts = file.path.split("/");
	let folder = root;
	for (let depth = 0; depth < parts.length - 1; depth++) {
		folder = findOrAddFolder(folder, parts[depth], parts.slice(0, depth + 1).join("/"));
	}
	folder.children.push({ kind: "file", name: parts[parts.length - 1], file });
}

function findOrAddFolder<T>(parent: FolderNode<T>, name: string, path: string): FolderNode<T> {
	const existing = parent.children.find((child) => child.kind === "folder" && child.name === name);
	if (existing?.kind === "folder") return existing;
	const folder: FolderNode<T> = { kind: "folder", name, path, children: [] };
	parent.children.push(folder);
	return folder;
}

function finishNodes<T>(nodes: TreeNode<T>[]): TreeNode<T>[] {
	return nodes.map(finishNode).sort(compareNodes);
}

function finishNode<T>(node: TreeNode<T>): TreeNode<T> {
	if (node.kind === "file") return node;
	let folder = node;
	while (folder.children.length === 1 && folder.children[0].kind === "folder") {
		const only = folder.children[0];
		folder = { kind: "folder", name: `${folder.name}/${only.name}`, path: only.path, children: only.children };
	}
	return { ...folder, children: finishNodes(folder.children) };
}

function compareNodes<T>(a: TreeNode<T>, b: TreeNode<T>): number {
	if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
	return a.name.localeCompare(b.name);
}
