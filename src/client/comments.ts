import type { Comment } from "../comments.ts";
import { barLines, describeLines, groupByStart, stackCards } from "../shared/comment-layout.ts";
import type { CommentGroup } from "../shared/comment-layout.ts";
import { renderMarkdown } from "../shared/markdown.ts";
import type { Side } from "../shared/scroll.ts";
import { LINE_HEIGHT } from "./diff-view.ts";
import { highlightCodeBlocks } from "./highlight.ts";
import { formatAge } from "./panel.ts";

export interface CommentLayerElements {
	panes: HTMLElement;
	scrollers: Record<Side, HTMLElement>;
}

export interface CommentLayer {
	render(comments: Comment[]): void;
	toggleCards(): void;
	toggleStyle(): void;
	reveal(commentId: string): void;
	focus(commentId: string | null): void;
}

// ponytail: trial of two comment styles, delete the losing one once the user picks
type CommentStyle = "side" | "inline";

interface Card {
	group: CommentGroup;
	endLine: number;
	card: HTMLElement;
	connector: HTMLElement;
}

interface SideState {
	scroller: HTMLElement;
	layer: HTMLElement;
	cards: Card[];
}

const CARD_MAX_WIDTH = 460;
const CARD_WIDTH_FRACTION = 0.4;
const CARD_MARGIN = 8;
const CARD_GAP = 6;
const CONNECTOR_WIDTH = 16;
const CONNECTOR_DROP = 10;
const GUTTER_WIDTH = 52;
const STYLE_KEY = "owl.commentStyle";

export function createCommentLayer(elements: CommentLayerElements): CommentLayer {
	const sides = (["old", "new"] as const).map((side) => ({ side, state: createSide(elements, side) }));
	const hiddenIds = new Set<string>();
	let style = loadStyle();
	let allHidden = false;
	let openId: string | null = null;
	let layoutQueued = false;

	for (const { state } of sides) {
		state.scroller.addEventListener("scroll", queueLayout);
		state.scroller.addEventListener("click", (event) => handleMarkerClick(state, event));
		new ResizeObserver(queueLayout).observe(state.scroller);
	}

	function queueLayout(): void {
		if (layoutQueued) return;
		layoutQueued = true;
		requestAnimationFrame(() => {
			layoutQueued = false;
			for (const { state } of sides) layoutSide(state, style, isShown);
		});
	}

	function isShown(group: CommentGroup): boolean {
		if (style === "inline") return group.comments.some((comment) => comment.id === openId);
		return !allHidden && !group.comments.every((comment) => hiddenIds.has(comment.id));
	}

	function setGroupHidden(group: CommentGroup, hidden: boolean): void {
		for (const { id } of group.comments) {
			if (hidden) hiddenIds.add(id);
			else hiddenIds.delete(id);
		}
	}

	function openGroup(group: CommentGroup): void {
		openId = group.comments[0].id;
		allHidden = false;
		setGroupHidden(group, false);
	}

	function closeGroup(group: CommentGroup): void {
		setGroupHidden(group, true);
		if (style === "inline") openId = null;
		queueLayout();
	}

	function handleMarkerClick({ cards }: SideState, event: MouseEvent): void {
		const num = (event.target as Element).closest<HTMLElement>(".num[data-c]");
		const card = cards.find(({ group }) => group.line === Number(num?.dataset.n));
		if (!card) return;
		if (isShown(card.group)) closeGroup(card.group);
		else openGroup(card.group);
		queueLayout();
	}

	function render(comments: Comment[]): void {
		for (const { side, state } of sides) {
			renderSide(
				state,
				comments.filter((comment) => comment.side === side),
				closeGroup
			);
		}
		queueLayout();
	}

	function toggleCards(): void {
		if (style === "inline") openId = null;
		else allHidden = !allHidden;
		queueLayout();
	}

	function toggleStyle(): void {
		style = style === "side" ? "inline" : "side";
		saveStyle(style);
		queueLayout();
	}

	function reveal(commentId: string): void {
		const card = sides
			.flatMap(({ state }) => state.cards)
			.find(({ group }) => group.comments.some((c) => c.id === commentId));
		if (card) openGroup(card.group);
		queueLayout();
	}

	function findGroup(commentId: string): CommentGroup | undefined {
		const cards = sides.flatMap(({ state }) => state.cards);
		return cards.find(({ group }) => group.comments.some((c) => c.id === commentId))?.group;
	}

	function focus(commentId: string | null): void {
		if (style !== "inline") return;
		const group = commentId === null ? undefined : findGroup(commentId);
		const isHidden = group?.comments.every((comment) => hiddenIds.has(comment.id));
		openId = group && !isHidden ? commentId : null;
		queueLayout();
	}

	return { render, toggleCards, toggleStyle, reveal, focus };
}

function loadStyle(): CommentStyle {
	try {
		return localStorage.getItem(STYLE_KEY) === "inline" ? "inline" : "side";
	} catch {
		return "side";
	}
}

function saveStyle(style: CommentStyle): void {
	try {
		localStorage.setItem(STYLE_KEY, style);
	} catch {}
}

function createSide(elements: CommentLayerElements, side: Side): SideState {
	const layer = document.createElement("div");
	layer.className = "comment-layer";
	elements.panes.append(layer);
	return { scroller: elements.scrollers[side], layer, cards: [] };
}

function renderSide(state: SideState, comments: Comment[], onClose: (group: CommentGroup) => void): void {
	const lines = state.scroller.getElementsByClassName("line");
	const groups = groupByStart(comments, lines.length);
	drawMarkers(state.scroller, lines, comments, groups);
	state.cards = groups.map((group) => createCard(group, lines.length, onClose));
	state.layer.replaceChildren(...state.cards.flatMap(({ connector, card }) => [connector, card]));
}

function drawMarkers(
	scroller: HTMLElement,
	lines: HTMLCollectionOf<Element>,
	comments: Comment[],
	groups: CommentGroup[]
): void {
	for (const line of scroller.querySelectorAll(".commented")) line.classList.remove("commented");
	for (const num of scroller.querySelectorAll<HTMLElement>(".num[data-c]")) delete num.dataset.c;
	for (const line of barLines(comments, lines.length)) lines[line - 1].classList.add("commented");
	for (const group of groups) {
		const num = lines[group.line - 1].querySelector<HTMLElement>(".num");
		if (num) num.dataset.c = String(group.comments.length);
	}
}

function createCard(group: CommentGroup, lineCount: number, onClose: (group: CommentGroup) => void): Card {
	const card = document.createElement("div");
	card.className = "card";
	card.append(...group.comments.map((comment) => createEntry(comment, () => onClose(group))));
	const endLine = Math.min(Math.max(...group.comments.map((comment) => comment.end)), lineCount);
	const connector = document.createElement("div");
	connector.className = "connector";
	return { group, endLine, card, connector };
}

function createEntry(comment: Comment, onClose: () => void): HTMLElement {
	const entry = document.createElement("div");
	entry.className = "entry";
	const head = document.createElement("div");
	head.className = "head";
	const label = document.createElement("span");
	label.textContent = `agent · ${formatAge(comment.createdAt)} · ${describeLines(comment)}`;
	const remove = document.createElement("button");
	remove.className = "del";
	remove.title = "close";
	remove.textContent = "×";
	remove.onclick = onClose;
	head.append(label, remove);
	const body = document.createElement("div");
	body.className = "body";
	body.innerHTML = renderMarkdown(comment.text);
	highlightCodeBlocks(body);
	entry.append(head, body);
	return entry;
}

function layoutSide(
	{ scroller, layer, cards }: SideState,
	style: CommentStyle,
	isShown: (group: CommentGroup) => boolean
): void {
	const { clientWidth: width, clientHeight: height, scrollTop } = scroller;
	Object.assign(layer.style, {
		left: `${scroller.offsetLeft}px`,
		top: `${scroller.offsetTop}px`,
		width: `${width}px`,
		height: `${height}px`
	});
	const isInline = style === "inline";
	const shown = cards.filter(({ group }) => isShown(group));
	for (const entry of cards) {
		entry.card.hidden = !shown.includes(entry);
		entry.connector.hidden = isInline || entry.card.hidden;
	}
	const cardWidth = isInline
		? width - GUTTER_WIDTH - CARD_MARGIN
		: Math.min(width * CARD_WIDTH_FRACTION, CARD_MAX_WIDTH);
	const left = isInline ? GUTTER_WIDTH : width - CARD_MARGIN - cardWidth;
	for (const { card } of shown) {
		Object.assign(card.style, { width: `${cardWidth}px`, left: `${left}px`, maxHeight: `${height / 2}px` });
	}
	// ponytail: an inline card opened near the pane bottom is clipped, scroll to see it
	const anchors = shown.map(({ group, endLine }) => (isInline ? endLine : group.line - 1) * LINE_HEIGHT - scrollTop);
	const boxes = shown.map(({ card }, i) => ({ anchor: anchors[i], height: card.offsetHeight }));
	const tops = isInline ? anchors : stackCards(boxes, CARD_GAP);
	shown.forEach(({ card, connector, group }, i) => {
		card.style.top = `${tops[i]}px`;
		const lineY = (group.line - 1) * LINE_HEIGHT - scrollTop + LINE_HEIGHT / 2;
		placeConnector(connector, left, lineY, tops[i] + CONNECTOR_DROP);
	});
}

function placeConnector(connector: HTMLElement, cardLeft: number, fromY: number, toY: number): void {
	Object.assign(connector.style, {
		left: `${cardLeft - CONNECTOR_WIDTH}px`,
		width: `${CONNECTOR_WIDTH}px`,
		top: `${fromY}px`,
		height: `${Math.max(1, toY - fromY)}px`
	});
}
