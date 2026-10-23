export const MIN_SIDEBAR_PX = 180;
export const MAX_SIDEBAR_FRACTION = 0.6;
export const MIN_SPLIT_PART_PX = 60;
export const MIN_PANE_FRACTION = 0.15;

function clamp(value: number, low: number, high: number): number {
	return Math.min(Math.max(value, low), high);
}

export function clampSidebar(px: number, windowWidth: number): number {
	return clamp(px, MIN_SIDEBAR_PX, windowWidth * MAX_SIDEBAR_FRACTION);
}

export function clampSplit(px: number, totalPx: number): number {
	return clamp(px, MIN_SPLIT_PART_PX, totalPx - MIN_SPLIT_PART_PX);
}

export function clampRatio(ratio: number): number {
	return clamp(ratio, MIN_PANE_FRACTION, 1 - MIN_PANE_FRACTION);
}
