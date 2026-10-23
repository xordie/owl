import assert from "node:assert/strict";
import { test } from "node:test";
import { clampRatio, clampSidebar, clampSplit } from "../src/shared/sizes.ts";

test("sidebar keeps 180 px and at most 60% of the window", () => {
	assert.equal(clampSidebar(50, 1500), 180);
	assert.equal(clampSidebar(340, 1500), 340);
	assert.equal(clampSidebar(2000, 1500), 900);
});

test("each part of the split keeps 60 px", () => {
	assert.equal(clampSplit(10, 800), 60);
	assert.equal(clampSplit(280, 800), 280);
	assert.equal(clampSplit(790, 800), 740);
});

test("each pane keeps 15% of the area", () => {
	assert.equal(clampRatio(0.05), 0.15);
	assert.equal(clampRatio(0.5), 0.5);
	assert.equal(clampRatio(0.99), 0.85);
});
