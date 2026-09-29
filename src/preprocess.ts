import { openSync, readSync, closeSync, readFileSync } from "node:fs";

/** Read the cwd recorded in the session header (first {"type":"session"} line). */
export function readSessionCwd(file: string): string | null {
	try {
		const fd = openSync(file, "r");
		const buf = Buffer.alloc(8192);
		const n = readSync(fd, buf, 0, 8192, 0);
		closeSync(fd);
		for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as { type?: string; cwd?: string };
				if ((entry.type === "session" || entry.cwd) && entry.cwd) return entry.cwd;
			} catch {
				// keep scanning
			}
		}
	} catch {
		// unreadable file
	}
	return null;
}

export interface SessionDelta {
	text: string;
	newOffset: number;
}

interface ContentPart {
	type?: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: unknown;
	input?: unknown;
	content?: unknown;
	toolName?: string;
}

const TOOL_CALL_BUDGET = 200;
const TOOL_RESULT_BUDGET = 300;

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n)}…` : s;
}

function partToLine(role: string, part: ContentPart): string | null {
	switch (part.type) {
		case "text":
			return part.text?.trim() ? `[${role}] ${part.text.trim()}` : null;
		case "thinking":
			return null; // reasoning noise, skip
		case "toolCall":
		case "tool_call": {
			const name = part.name ?? part.toolName ?? "tool";
			const args = truncate(JSON.stringify(part.arguments ?? part.input ?? {}), TOOL_CALL_BUDGET);
			return `[tool call] ${name}: ${args}`;
		}
		case "toolResult":
		case "tool_result": {
			let body = "";
			if (typeof part.content === "string") body = part.content;
			else if (Array.isArray(part.content)) {
				body = (part.content as ContentPart[])
					.filter((p) => p.type === "text" && p.text)
					.map((p) => p.text!)
					.join("\n");
			}
			return body.trim() ? `[tool result] ${truncate(body.trim(), TOOL_RESULT_BUDGET)}` : null;
		}
		default:
			return null;
	}
}

/**
 * Read the unprocessed tail of a pi session JSONL file (append-only) and condense it
 * into clean transcript text. Tool noise is truncated; thinking blocks are dropped.
 */
export function readPiSessionDelta(file: string, offset: number, maxChars: number): SessionDelta {
	const buf = readFileSync(file);
	let slice = buf.subarray(offset);
	let newOffset = buf.length;

	if (offset > 0) {
		// The offset may land mid-line; drop the first partial line.
		const nl = slice.indexOf(0x0a);
		if (nl === -1) return { text: "", newOffset };
		slice = slice.subarray(nl + 1);
	}

	const lines: string[] = [];
	for (const rawLine of slice.toString("utf8").split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		let entry: { type?: string; message?: { role?: string; content?: ContentPart[] | string } };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const role = entry.message.role ?? "?";
		const content = entry.message.content;
		if (typeof content === "string") {
			if (content.trim()) lines.push(`[${role}] ${content.trim()}`);
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			const out = partToLine(role, part);
			if (out) lines.push(out);
		}
	}

	let text = lines.join("\n");
	if (text.length > maxChars) {
		const head = Math.floor(maxChars * 0.3);
		const tail = maxChars - head;
		text = `${text.slice(0, head)}\n\n...[${text.length - maxChars} chars omitted from the middle]...\n\n${text.slice(-tail)}`;
	}
	return { text, newOffset };
}

/**
 * Claude Code session format: entries with type "user"/"assistant",
 * message.content as string or array of text/thinking/tool_use/tool_result parts.
 */
export function readClaudeCodeSessionDelta(file: string, offset: number, maxChars: number): SessionDelta {
	const buf = readFileSync(file);
	let slice = buf.subarray(offset);
	const newOffset = buf.length;

	if (offset > 0) {
		const nl = slice.indexOf(0x0a);
		if (nl === -1) return { text: "", newOffset };
		slice = slice.subarray(nl + 1);
	}

	const lines: string[] = [];
	for (const rawLine of slice.toString("utf8").split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		let entry: {
			type?: string;
			isMeta?: boolean;
			message?: { role?: string; content?: ContentPart[] | string };
		};
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if ((entry.type !== "user" && entry.type !== "assistant") || entry.isMeta || !entry.message) continue;
		const role = entry.message.role ?? entry.type;
		const content = entry.message.content;
		if (typeof content === "string") {
			// Skip command/system plumbing messages.
			if (content.trim() && !content.startsWith("<command-") && !content.startsWith("<local-command"))
				lines.push(`[${role}] ${content.trim()}`);
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			// Claude Code names its tool parts tool_use / tool_result
			const mapped =
				part.type === "tool_use"
					? { ...part, type: "toolCall", arguments: part.input }
					: part;
			const out = partToLine(role, mapped);
			if (out) lines.push(out);
		}
	}

	let text = lines.join("\n");
	if (text.length > maxChars) {
		const head = Math.floor(maxChars * 0.3);
		const tail = maxChars - head;
		text = `${text.slice(0, head)}\n\n...[${text.length - maxChars} chars omitted from the middle]...\n\n${text.slice(-tail)}`;
	}
	return { text, newOffset };
}

/** Pluggable per-agent session parsers. Add opencode etc. here. */
export function readSessionDelta(agent: string, file: string, offset: number, maxChars: number): SessionDelta {
	switch (agent) {
		case "pi":
			return readPiSessionDelta(file, offset, maxChars);
		case "claude-code":
			return readClaudeCodeSessionDelta(file, offset, maxChars);
		default:
			throw new Error(`unsupported agent session format: ${agent}`);
	}
}
