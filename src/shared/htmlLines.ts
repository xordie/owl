const PIECE = /<span[^>]*>|<\/span>|\n|[^<\n]+/g;
const TAG = /<[^>]*>/g;

export function splitHighlightedLines(html: string): string[] {
	const lines: string[] = [];
	const openTags: string[] = [];
	let current = "";
	for (const [piece] of html.matchAll(PIECE)) {
		if (piece === "\n") {
			lines.push(current + "</span>".repeat(openTags.length));
			current = openTags.join("");
			continue;
		}
		current += piece;
		if (piece === "</span>") openTags.pop();
		else if (piece.startsWith("<span")) openTags.push(piece);
	}
	lines.push(current);
	if (lines[lines.length - 1].replace(TAG, "") === "") lines.pop();
	return lines;
}
