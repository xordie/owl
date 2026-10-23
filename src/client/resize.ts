import { clampRatio, clampSidebar, clampSplit } from "../shared/sizes.ts";

export interface ResizeElements {
	left: HTMLElement;
	sources: HTMLElement;
	leftHandle: HTMLElement;
	splitHandle: HTMLElement;
	oldPane: HTMLElement;
	newPane: HTMLElement;
	strip: Element;
}

interface Sizes {
	sidebar: number;
	sources: number;
	ratio: number;
}

interface Handle {
	el: Element;
	axis: "x" | "y";
	key: keyof Sizes;
	read: () => number;
	fromPx: (px: number) => number;
}

const DEFAULTS: Sizes = { sidebar: 340, sources: 280, ratio: 0.5 };
const STORAGE_KEY = "owl.sizes";

export function setupResize(els: ResizeElements): void {
	const sizes = loadSizes();
	const apply = (): void => {
		els.left.style.width = `${clampSidebar(sizes.sidebar, window.innerWidth)}px`;
		els.sources.style.height = `${clampSplit(sizes.sources, els.left.clientHeight - els.splitHandle.offsetHeight)}px`;
		els.oldPane.style.flex = `${sizes.ratio} 1 0`;
		els.newPane.style.flex = `${1 - sizes.ratio} 1 0`;
	};
	const handles: Handle[] = [
		{
			el: els.leftHandle,
			axis: "x",
			key: "sidebar",
			read: () => els.left.offsetWidth,
			fromPx: (px) => clampSidebar(px, window.innerWidth)
		},
		{
			el: els.splitHandle,
			axis: "y",
			key: "sources",
			read: () => els.sources.offsetHeight,
			fromPx: (px) => clampSplit(px, els.left.clientHeight - els.splitHandle.offsetHeight)
		},
		{
			el: els.strip,
			axis: "x",
			key: "ratio",
			read: () => els.oldPane.offsetWidth,
			fromPx: (px) => clampRatio(px / (els.oldPane.offsetWidth + els.newPane.offsetWidth))
		}
	];
	for (const handle of handles) attach(handle, sizes, apply);
	window.addEventListener("resize", apply);
	apply();
}

function attach(handle: Handle, sizes: Sizes, apply: () => void): void {
	const { el, axis, key } = handle;
	const position = (event: PointerEvent): number => (axis === "x" ? event.clientX : event.clientY);
	let origin: { pointer: number; size: number } | null = null;

	el.addEventListener("pointerdown", (event) => {
		const down = event as PointerEvent;
		if (down.button !== 0) return;
		el.setPointerCapture(down.pointerId);
		origin = { pointer: position(down), size: handle.read() };
		el.classList.add("dragging");
		document.body.classList.add("resizing");
	});
	el.addEventListener("pointermove", (event) => {
		if (!origin) return;
		sizes[key] = handle.fromPx(origin.size + position(event as PointerEvent) - origin.pointer);
		apply();
	});
	const finish = (): void => {
		if (!origin) return;
		origin = null;
		el.classList.remove("dragging");
		document.body.classList.remove("resizing");
		saveSizes(sizes);
	};
	el.addEventListener("pointerup", finish);
	el.addEventListener("pointercancel", finish);
	el.addEventListener("dblclick", () => {
		sizes[key] = DEFAULTS[key];
		apply();
		saveSizes(sizes);
	});
}

function loadSizes(): Sizes {
	try {
		const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<Sizes>;
		return {
			sidebar: validNumber(stored.sidebar, DEFAULTS.sidebar),
			sources: validNumber(stored.sources, DEFAULTS.sources),
			ratio: validNumber(stored.ratio, DEFAULTS.ratio)
		};
	} catch {
		return { ...DEFAULTS };
	}
}

function validNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function saveSizes(sizes: Sizes): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes));
	} catch {}
}
