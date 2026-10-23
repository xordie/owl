import type { FileDetail } from "../git.ts";
import type { Chunk, ChunkKind, WordRange } from "../shared/diff.ts";
import { changeIndexAt, mapLine } from "../shared/scroll.ts";
import type { Side } from "../shared/scroll.ts";
import { highlightLines } from "./highlight.ts";

export interface ScrollPosition {
	top: number;
	left: number;
}

export interface DiffElements {
	panes: HTMLElement;
	note: HTMLElement;
	oldScroller: HTMLElement;
	newScroller: HTMLElement;
	strip: SVGSVGElement;
}

export interface DiffView {
	showFile(detail: FileDetail, restore?: ScrollPosition): void;
	showMessage(text: string): void;
	changeCount(): number;
	currentChange(): number;
	currentChunk(): Chunk | undefined;
	goToChange(index: number): void;
	goToLine(side: Side, line: number): void;
	scrollPosition(): ScrollPosition;
}

type Kinds = (ChunkKind | undefined)[];

export const LINE_HEIGHT = 18;
const FOCUS_FRACTION = 1 / 3;
const SVG_NS = "http://www.w3.org/2000/svg";
const SCROLL_TOLERANCE = 0.5;
const USER_SCROLL_MS = 200;

export function createDiffView(elements: DiffElements, onChange: () => void): DiffView {
	const scrollers: Record<Side, HTMLElement> = { old: elements.oldScroller, new: elements.newScroller };
	const contents: Record<Side, HTMLElement> = { old: createContent(scrollers.old), new: createContent(scrollers.new) };
	const programmatic: Record<Side, ScrollPosition | null> = { old: null, new: null };
	let chunks: Chunk[] = [];
	let current = -1;
	let drawQueued = false;
	let userScrolling = false;
	let userScrollTimer: ReturnType<typeof setTimeout> | undefined;

	for (const side of ["old", "new"] as const) {
		scrollers[side].addEventListener("scroll", () => handleScroll(side));
		scrollers[side].addEventListener("wheel", markUserScroll, { passive: true });
		scrollers[side].addEventListener("touchmove", markUserScroll, { passive: true });
	}
	new ResizeObserver(() => {
		syncFrom("new");
		queueDraw();
	}).observe(scrollers.new);
	elements.panes.addEventListener("pointerdown", () => (userScrolling = true));
	document.addEventListener("pointerup", markUserScroll);

	function markUserScroll(): void {
		userScrolling = true;
		clearTimeout(userScrollTimer);
		userScrollTimer = setTimeout(() => (userScrolling = false), USER_SCROLL_MS);
	}

	function handleScroll(side: Side): void {
		if (!isProgrammatic(side)) {
			syncFrom(side);
			if (userScrolling) current = changeAtFocus();
			onChange();
		}
		queueDraw();
	}

	function isProgrammatic(side: Side): boolean {
		const expected = programmatic[side];
		const scroller = scrollers[side];
		return (
			expected !== null &&
			Math.abs(scroller.scrollTop - expected.top) < SCROLL_TOLERANCE &&
			Math.abs(scroller.scrollLeft - expected.left) < SCROLL_TOLERANCE
		);
	}

	function setScroll(side: Side, top: number, left: number): void {
		const scroller = scrollers[side];
		scroller.scrollTop = top;
		scroller.scrollLeft = left;
		programmatic[side] = { top: scroller.scrollTop, left: scroller.scrollLeft };
	}

	function syncFrom(side: Side): void {
		const source = scrollers[side];
		const half = source.clientHeight / 2;
		const middleLine = (source.scrollTop + half) / LINE_HEIGHT;
		const other: Side = side === "old" ? "new" : "old";
		setScroll(other, mapLine(chunks, middleLine, side) * LINE_HEIGHT - half, source.scrollLeft);
	}

	function changeAtFocus(): number {
		const focusLine = (scrollers.new.scrollTop + scrollers.new.clientHeight * FOCUS_FRACTION) / LINE_HEIGHT;
		return changeIndexAt(chunks, focusLine + 0.05);
	}

	function queueDraw(): void {
		if (drawQueued) return;
		drawQueued = true;
		requestAnimationFrame(() => {
			drawQueued = false;
			drawBands();
		});
	}

	function drawBands(): void {
		const height = scrollers.old.clientHeight;
		const width = elements.strip.clientWidth;
		const oldTop = scrollers.old.scrollTop;
		const newTop = scrollers.new.scrollTop;
		elements.strip.setAttribute("height", String(height));
		const bands = chunks
			.map((chunk) => bandPath(chunk, oldTop, newTop, width))
			.filter((band) => isVisible(band.ys, height))
			.map((band) => band.path);
		elements.strip.replaceChildren(...bands);
	}

	function showMessage(text: string): void {
		chunks = [];
		current = -1;
		CSS.highlights.delete("word");
		elements.panes.hidden = true;
		elements.note.hidden = false;
		elements.note.textContent = text;
		elements.strip.replaceChildren();
	}

	function showFile(detail: FileDetail, restore?: ScrollPosition): void {
		if ("binary" in detail) return showMessage("Binary file, not shown.");
		if ("tooLarge" in detail) {
			const { oldLines, newLines } = detail.tooLarge;
			return showMessage(`File too large to show (${oldLines} lines before, ${newLines} lines after).`);
		}
		chunks = detail.chunks;
		elements.note.hidden = true;
		elements.panes.hidden = false;
		renderPane("old", highlightLines(detail.oldText, detail.oldPath));
		renderPane("new", highlightLines(detail.newText, detail.path));
		setScroll("old", 0, 0);
		setScroll("new", 0, 0);
		if (restore) {
			setScroll("new", restore.top, restore.left);
			syncFrom("new");
		}
		highlightWords();
		current = -1;
		if (!restore) goToChange(0);
		else current = changeAtFocus();
		queueDraw();
	}

	function renderPane(side: Side, lines: string[]): void {
		const kinds = lineKinds(side);
		const rows = lines.map((html, i) => lineHtml(html, i, kinds[i]));
		const markers = chunks.filter((chunk) => isEmptyOn(chunk, side)).map((chunk) => markerHtml(chunk, side));
		contents[side].style.height = `${lines.length * LINE_HEIGHT}px`;
		contents[side].innerHTML = rows.join("") + markers.join("");
	}

	function lineKinds(side: Side): Kinds {
		const kinds: Kinds = [];
		for (const chunk of chunks) {
			const [start, end] = side === "old" ? [chunk.oldStart, chunk.oldEnd] : [chunk.newStart, chunk.newEnd];
			for (let line = start; line < end; line++) kinds[line] = chunk.kind;
		}
		return kinds;
	}

	function highlightWords(): void {
		const ranges: Range[] = [];
		for (const chunk of chunks) {
			ranges.push(...wordRanges(contents.old, chunk.oldWords ?? []));
			ranges.push(...wordRanges(contents.new, chunk.newWords ?? []));
		}
		CSS.highlights.set("word", new Highlight(...ranges));
	}

	function goToChange(index: number): void {
		const chunk = chunks[index];
		if (!chunk) return;
		const side: Side = chunk.kind === "deleted" ? "old" : "new";
		const line = side === "old" ? chunk.oldStart : chunk.newStart;
		const focusOffset = scrollers[side].clientHeight * FOCUS_FRACTION;
		setScroll(side, line * LINE_HEIGHT - focusOffset, scrollers[side].scrollLeft);
		syncFrom(side);
		current = index;
		onChange();
		queueDraw();
	}

	function goToLine(side: Side, line: number): void {
		const focusOffset = scrollers[side].clientHeight * FOCUS_FRACTION;
		setScroll(side, (line - 1) * LINE_HEIGHT - focusOffset, scrollers[side].scrollLeft);
		syncFrom(side);
		current = changeAtFocus();
		onChange();
		queueDraw();
	}

	return {
		showFile,
		showMessage,
		changeCount: () => chunks.length,
		currentChange: () => current,
		currentChunk: () => chunks[current],
		goToChange,
		goToLine,
		scrollPosition: () => ({ top: scrollers.new.scrollTop, left: scrollers.new.scrollLeft })
	};
}

function createContent(scroller: HTMLElement): HTMLElement {
	const content = document.createElement("div");
	content.className = "content";
	scroller.replaceChildren(content);
	return content;
}

function lineHtml(html: string, index: number, kind: ChunkKind | undefined): string {
	const tint = kind ? ` k-${kind}` : "";
	return `<div class="line${tint}"><span class="num" data-n="${index + 1}"></span><span class="code">${html}</span></div>`;
}

function isEmptyOn(chunk: Chunk, side: Side): boolean {
	return side === "old" ? chunk.oldStart === chunk.oldEnd : chunk.newStart === chunk.newEnd;
}

function markerHtml(chunk: Chunk, side: Side): string {
	const line = side === "old" ? chunk.oldStart : chunk.newStart;
	const top = Math.max(0, line * LINE_HEIGHT - 1);
	return `<div class="marker k-${chunk.kind}" style="top:${top}px"></div>`;
}

function wordRanges(content: HTMLElement, words: WordRange[]): Range[] {
	return words.flatMap(([line, from, to]) => {
		const code = content.children[line]?.querySelector(".code");
		return code ? [textRange(code, from, to)] : [];
	});
}

function textRange(code: Element, from: number, to: number): Range {
	const range = new Range();
	const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
	let offset = 0;
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const length = (node as Text).length;
		if (from >= offset && from < offset + length) range.setStart(node, from - offset);
		if (to > offset && to <= offset + length) {
			range.setEnd(node, to - offset);
			break;
		}
		offset += length;
	}
	return range;
}

interface Band {
	path: SVGPathElement;
	ys: number[];
}

function bandPath(chunk: Chunk, oldScrollTop: number, newScrollTop: number, width: number): Band {
	const oldTop = chunk.oldStart * LINE_HEIGHT - oldScrollTop;
	const oldBottom = chunk.oldEnd * LINE_HEIGHT - oldScrollTop;
	const newTop = chunk.newStart * LINE_HEIGHT - newScrollTop;
	const newBottom = chunk.newEnd * LINE_HEIGHT - newScrollTop;
	const mid = width / 2;
	const path = document.createElementNS(SVG_NS, "path");
	path.setAttribute("class", `band k-${chunk.kind}`);
	path.setAttribute(
		"d",
		`M0,${oldTop} C${mid},${oldTop} ${mid},${newTop} ${width},${newTop} ` +
			`L${width},${newBottom} C${mid},${newBottom} ${mid},${oldBottom} 0,${oldBottom} Z`
	);
	return { path, ys: [oldTop, oldBottom, newTop, newBottom] };
}

function isVisible(ys: number[], height: number): boolean {
	return Math.max(...ys) >= 0 && Math.min(...ys) <= height;
}
