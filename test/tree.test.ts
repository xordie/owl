import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTree, treeFiles } from "../src/shared/tree.ts";

const files = (...paths: string[]) => paths.map((path) => ({ path }));

test("merges folders that hold a single folder", () => {
	const tree = buildTree(files("src/dataset/a.ts", "src/dataset/b.ts"));
	assert.equal(tree.length, 1);
	assert.equal(tree[0].kind === "folder" && tree[0].name, "src/dataset");
	assert.equal(tree[0].kind === "folder" && tree[0].path, "src/dataset");
});

test("does not merge a folder that also holds a file", () => {
	const tree = buildTree(files("src/x.ts", "src/dataset/a.ts"));
	assert.equal(tree[0].kind === "folder" && tree[0].name, "src");
	assert.deepEqual(tree[0].kind === "folder" && tree[0].children.map((child) => child.name), ["dataset", "x.ts"]);
});

test("puts folders before files and sorts by name", () => {
	const tree = buildTree(files("z.ts", "b/one.ts", "b/two.ts", "a.ts", "c/one.ts", "c/two.ts"));
	assert.deepEqual(
		tree.map((node) => node.name),
		["b", "c", "a.ts", "z.ts"]
	);
});

test("lists files in tree order", () => {
	const order = treeFiles(buildTree(files("z.ts", "src/b.ts", "src/a.ts", "a.ts"))).map((file) => file.path);
	assert.deepEqual(order, ["src/a.ts", "src/b.ts", "a.ts", "z.ts"]);
});
