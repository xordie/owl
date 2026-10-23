type Block = { kind: "p" | "ul" | "ol"; lines: string[] };

const FENCE_OPEN = /^```([\w+-]*)\s*$/;
const FENCE_CLOSE = /^```\s*$/;
const BULLET = /^[-*] (.*)$/;
const NUMBERED = /^\d+\. (.*)$/;

export function renderMarkdown(text: string): string {
	const lines = escapeHtml(text).replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	let block: Block | null = null;
	const flush = (): void => {
		if (block) out.push(renderBlock(block));
		block = null;
	};
	const add = (kind: Block["kind"], line: string): void => {
		if (block?.kind !== kind) {
			flush();
			block = { kind, lines: [] };
		}
		block.lines.push(line);
	};
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const fence = FENCE_OPEN.exec(line);
		if (fence) {
			flush();
			const code: string[] = [];
			while (++index < lines.length && !FENCE_CLOSE.test(lines[index])) code.push(lines[index]);
			out.push(renderCode(fence[1], code));
		} else if (line.trim() === "") flush();
		else if (BULLET.test(line)) add("ul", BULLET.exec(line)![1]);
		else if (NUMBERED.test(line)) add("ol", NUMBERED.exec(line)![1]);
		else add("p", line);
	}
	flush();
	return out.join("");
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function renderCode(language: string, lines: string[]): string {
	const attribute = language === "" ? "" : ` class="language-${language}"`;
	return `<pre><code${attribute}>${lines.join("\n")}</code></pre>`;
}

function renderBlock(block: Block): string {
	const inline = block.lines.map(renderInline);
	if (block.kind === "p") return `<p>${inline.join("<br>")}</p>`;
	return `<${block.kind}>${inline.map((item) => `<li>${item}</li>`).join("")}</${block.kind}>`;
}

function renderInline(line: string): string {
	return line
		.split(/(`[^`]+`)/)
		.map((part, index) => (index % 2 === 1 ? `<code>${part.slice(1, -1)}</code>` : renderBold(part)))
		.join("");
}

function renderBold(text: string): string {
	return text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}
