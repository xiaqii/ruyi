import { openSync, readSync, closeSync, fstatSync } from "node:fs";

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

/** Max characters kept from a single formatted transcript line (huge pastes, minified blobs). */
const MAX_LINE_CHARS = 8192;

/**
 * Yield complete lines of a JSONL file as {line, end} where `end` is the byte
 * offset just past the trailing newline. Reads in chunks (no whole-file
 * string conversion), so multi-hundred-MB session files stay cheap per call.
 * A non-zero `offset` may land mid-line; the first partial line is dropped.
 * A trailing line without a newline is left for a future call (append-only files).
 */
function* iterLines(file: string, offset: number): Generator<{ line: string; end: number }> {
	const fd = openSync(file, "r");
	try {
		const size = fstatSync(fd).size;
		const CHUNK = 4 << 20;
		const buf = Buffer.allocUnsafe(CHUNK);
		let pos = offset;
		let pending = Buffer.alloc(0);
		let pendingStart = offset;
		let skipFirst = offset > 0;
		while (true) {
			let idx: number;
			while ((idx = pending.indexOf(0x0a)) !== -1) {
				const line = pending.subarray(0, idx).toString("utf8");
				const end = pendingStart + idx + 1;
				pending = pending.subarray(idx + 1);
				pendingStart = end;
				if (skipFirst) {
					skipFirst = false;
					continue;
				}
				yield { line, end };
			}
			if (pos >= size) break;
			const n = readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
			if (n <= 0) break;
			pos += n;
			pending = Buffer.concat([pending, buf.subarray(0, n)]);
		}
	} finally {
		closeSync(fd);
	}
}

/**
 * Shared delta-collecting loop: format each parsed entry into transcript lines
 * and stop at a line boundary once `maxChars` of text has accumulated, so the
 * next call resumes exactly where this one stopped. Never drops the middle of
 * a file the way whole-file truncation did.
 */
function collectDelta(
	file: string,
	offset: number,
	maxChars: number,
	formatEntry: (entry: unknown) => string[],
): SessionDelta {
	const out: string[] = [];
	let total = 0;
	let newOffset = offset;
	for (const { line, end } of iterLines(file, offset)) {
		newOffset = end;
		let entry: unknown;
		try {
			entry = JSON.parse(line.trim());
		} catch {
			continue;
		}
		for (const formatted of formatEntry(entry)) {
			const t = formatted.length > MAX_LINE_CHARS ? `${formatted.slice(0, MAX_LINE_CHARS)}…` : formatted;
			out.push(t);
			total += t.length + 1;
		}
		if (total >= maxChars) return { text: out.join("\n"), newOffset };
	}
	return { text: out.join("\n"), newOffset };
}

/**
 * Read the unprocessed tail of a pi session JSONL file (append-only) and condense it
 * into clean transcript text. Tool noise is truncated; thinking blocks are dropped.
 */
export function readPiSessionDelta(file: string, offset: number, maxChars: number): SessionDelta {
	return collectDelta(file, offset, maxChars, (entry) => {
		const e = entry as { type?: string; message?: { role?: string; content?: ContentPart[] | string } };
		if (e.type !== "message" || !e.message) return [];
		const role = e.message.role ?? "?";
		const content = e.message.content;
		if (typeof content === "string") return content.trim() ? [`[${role}] ${content.trim()}`] : [];
		if (!Array.isArray(content)) return [];
		const out: string[] = [];
		for (const part of content) {
			const line = partToLine(role, part);
			if (line) out.push(line);
		}
		return out;
	});
}

/**
 * Claude Code session format: entries with type "user"/"assistant",
 * message.content as string or array of text/thinking/tool_use/tool_result parts.
 */
export function readClaudeCodeSessionDelta(file: string, offset: number, maxChars: number): SessionDelta {
	return collectDelta(file, offset, maxChars, (entry) => {
		const e = entry as {
			type?: string;
			isMeta?: boolean;
			message?: { role?: string; content?: ContentPart[] | string };
		};
		if ((e.type !== "user" && e.type !== "assistant") || e.isMeta || !e.message) return [];
		const role = e.message.role ?? e.type;
		const content = e.message.content;
		if (typeof content === "string") {
			// Skip command/system plumbing messages.
			if (content.trim() && !content.startsWith("<command-") && !content.startsWith("<local-command"))
				return [`[${role}] ${content.trim()}`];
			return [];
		}
		if (!Array.isArray(content)) return [];
		const out: string[] = [];
		for (const part of content) {
			// Claude Code names its tool parts tool_use / tool_result
			const mapped = part.type === "tool_use" ? { ...part, type: "toolCall", arguments: part.input } : part;
			const line = partToLine(role, mapped);
			if (line) out.push(line);
		}
		return out;
	});
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
