import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, PROJECT_ROOT } from "./config.ts";
import { getDb, logTokens } from "./db.ts";

export interface LlmResult {
	text: string;
	inputTokens: number;
	outputTokens: number;
}

export interface CompleteOptions {
	system: string;
	user: string;
	step: string;
	runId?: string;
	sessionFile?: string;
	maxTokens?: number;
}

/** Extract the first JSON value (object or array) from LLM output, tolerating code fences and prose. */
export function extractJson<T>(text: string): T {
	const cleaned = text.replace(/```(?:json)?/gi, "");
	const start = cleaned.search(/[[{]/);
	if (start === -1) throw new Error(`no JSON found in LLM output: ${cleaned.slice(0, 200)}`);
	const open = cleaned[start]!;
	const close = open === "{" ? "}" : "]";
	// Find matching bracket respecting strings.
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = start; i < cleaned.length; i++) {
		const ch = cleaned[i]!;
		if (escape) {
			escape = false;
			continue;
		}
		if (ch === "\\" && inString) {
			escape = true;
			continue;
		}
		if (ch === '"') inString = !inString;
		if (inString) continue;
		if (ch === open) depth++;
		if (ch === close) {
			depth--;
			if (depth === 0) return JSON.parse(cleaned.slice(start, i + 1)) as T;
		}
	}
	throw new Error(`unbalanced JSON in LLM output: ${cleaned.slice(0, 200)}`);
}

/**
 * complete() + extractJson(), with one self-correction retry. LLMs occasionally
 * continue the transcript instead of answering; a nudge reliably fixes it.
 */
export async function completeJson<T>(opts: CompleteOptions): Promise<T> {
	const first = await complete(opts);
	try {
		return extractJson<T>(first.text);
	} catch {
		const retry = await complete({
			...opts,
			user:
				opts.user +
				"\n\nREMINDER: Your previous reply was not valid JSON. Respond with ONLY the JSON object/array described above. No transcript continuation, no prose, no code fences.",
		});
		return extractJson<T>(retry.text);
	}
}

function appendUsageLog(entry: Record<string, unknown>): void {
	try {
		const logsDir = resolve(PROJECT_ROOT, "logs");
		mkdirSync(logsDir, { recursive: true });
		const day = new Date().toISOString().slice(0, 10);
		appendFileSync(resolve(logsDir, `usage-${day}.jsonl`), JSON.stringify(entry) + "\n");
	} catch {
		// Logging must never break a run.
	}
}

/** One Anthropic-compatible /v1/messages call with token accounting. Throws on HTTP/API errors. */
export async function complete(opts: CompleteOptions): Promise<LlmResult> {
	const config = loadConfig();
	const { baseUrl, apiKey, model, maxTokens, requestTimeoutMs } = config.llm;

	const res = await fetch(`${baseUrl}/v1/messages`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify({
			model,
			max_tokens: opts.maxTokens ?? maxTokens,
			system: opts.system,
			messages: [{ role: "user", content: opts.user }],
		}),
		signal: AbortSignal.timeout(requestTimeoutMs),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`LLM request failed: HTTP ${res.status} ${body.slice(0, 300)}`);
	}

	const data = (await res.json()) as {
		content?: { type: string; text?: string }[];
		usage?: { input_tokens?: number; output_tokens?: number };
	};
	const text = (data.content ?? [])
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("\n");
	const inputTokens = data.usage?.input_tokens ?? 0;
	const outputTokens = data.usage?.output_tokens ?? 0;

	const at = new Date().toISOString();
	try {
		logTokens(getDb(config.dbPath), {
			runId: opts.runId,
			step: opts.step,
			sessionFile: opts.sessionFile,
			model,
			input: inputTokens,
			output: outputTokens,
		});
	} catch {
		// Token logging must never break a run.
	}
	appendUsageLog({
		at,
		run_id: opts.runId,
		step: opts.step,
		session_file: opts.sessionFile,
		model,
		input_tokens: inputTokens,
		output_tokens: outputTokens,
	});

	return { text, inputTokens, outputTokens };
}
