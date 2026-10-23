import { splitHighlightedLines } from "../shared/htmlLines.ts";

declare const hljs: {
	getLanguage(name: string): unknown;
	highlight(code: string, options: { language: string; ignoreIllegals: boolean }): { value: string };
};

export function highlightLines(text: string, path: string): string[] {
	return splitHighlightedLines(highlightToHtml(text, path));
}

export function highlightCodeBlocks(root: HTMLElement): void {
	for (const code of root.querySelectorAll<HTMLElement>("pre code[class^=language-]")) {
		const language = code.className.slice("language-".length);
		if (!hljs.getLanguage(language)) continue;
		code.innerHTML = hljs.highlight(code.textContent ?? "", { language, ignoreIllegals: true }).value;
	}
}

function highlightToHtml(text: string, path: string): string {
	const language = languageFor(path);
	if (language === null) return escapeHtml(text);
	try {
		return hljs.highlight(text, { language, ignoreIllegals: true }).value;
	} catch {
		return escapeHtml(text);
	}
}

function languageFor(path: string): string | null {
	const name = path.split("/").pop()?.toLowerCase() ?? "";
	const candidate = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
	return hljs.getLanguage(candidate) ? candidate : null;
}

function escapeHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
