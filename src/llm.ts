import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, PROJECT_ROOT } from "./config.ts";
import { getDb, logTokens } from "./db.ts";
import type { LlmTierConfig } from "./types.ts";

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
	timeoutMs?: number;
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

/** Steps served by the (cheap, fast, thinking-off) "recall" tier; everything else is "dream". */
const RECALL_STEPS = new Set(["understand", "rerank"]);

interface ResolvedLlm {
	protocol: "anthropic" | "openai";
	baseUrl: string;
	apiKey: string;
	model: string;
	maxTokens: number;
	requestTimeoutMs: number;
	thinking: "off" | "default" | number;
}

/** Merge base llm config with the per-tier override for this step. */
export function resolveLlm(step: string): ResolvedLlm {
	const config = loadConfig();
	const base = config.llm;
	const tier = RECALL_STEPS.has(step) ? "recall" : "dream";
	const override: LlmTierConfig | undefined = base.steps?.[tier];
	return {
		protocol: override?.protocol ?? base.protocol ?? "anthropic",
		baseUrl: (override?.baseUrl ?? base.baseUrl).replace(/\/+$/, ""),
		apiKey: override?.apiKey ?? base.apiKey,
		model: override?.model ?? base.model,
		maxTokens: override?.maxTokens ?? base.maxTokens,
		requestTimeoutMs: override?.requestTimeoutMs ?? base.requestTimeoutMs,
		thinking: override?.thinking ?? base.thinking ?? "default",
	};
}

interface Attempt {
	body: Record<string, unknown>;
	fixes: string[];
}

/** Build provider request body; `fixes` records downgrades already applied (for 400-driven retry). */
function buildBody(llm: ResolvedLlm, opts: CompleteOptions, fixes: Set<string>): Record<string, unknown> {
	const maxTok = opts.maxTokens ?? llm.maxTokens;
	if (llm.protocol === "openai") {
		const body: Record<string, unknown> = {
			model: llm.model,
			messages: [
				{ role: "system", content: opts.system },
				{ role: "user", content: opts.user },
			],
		};
		if (fixes.has("max_completion_tokens")) body.max_completion_tokens = maxTok;
		else body.max_tokens = maxTok;
		if (!fixes.has("response_format")) body.response_format = { type: "json_object" };
		return body;
	}
	// anthropic protocol
	const body: Record<string, unknown> = {
		model: llm.model,
		max_tokens: maxTok,
		system: opts.system,
		messages: [{ role: "user", content: opts.user }],
	};
	if (!fixes.has("thinking")) {
		if (llm.thinking === "off") body.thinking = { type: "disabled" };
		else if (typeof llm.thinking === "number") body.thinking = { type: "enabled", budget_tokens: llm.thinking };
	}
	return body;
}

function endpointOf(llm: ResolvedLlm): { url: string; headers: Record<string, string> } {
	if (llm.protocol === "openai") {
		const base = llm.baseUrl.endsWith("/v1") ? llm.baseUrl : `${llm.baseUrl}/v1`;
		return {
			url: `${base}/chat/completions`,
			headers: { "content-type": "application/json", authorization: `Bearer ${llm.apiKey}` },
		};
	}
	return {
		url: `${llm.baseUrl}/v1/messages`,
		headers: {
			"content-type": "application/json",
			"x-api-key": llm.apiKey,
			"anthropic-version": "2023-06-01",
		},
	};
}

function parseResponse(
	llm: ResolvedLlm,
	data: Record<string, unknown>,
): { text: string; inputTokens: number; outputTokens: number } {
	if (llm.protocol === "openai") {
		const choices = (data.choices ?? []) as { message?: { content?: string } }[];
		const usage = (data.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number };
		return {
			text: choices[0]?.message?.content ?? "",
			inputTokens: usage.prompt_tokens ?? 0,
			outputTokens: usage.completion_tokens ?? 0,
		};
	}
	const content = (data.content ?? []) as { type: string; text?: string }[];
	const usage = (data.usage ?? {}) as {
		input_tokens?: number;
		output_tokens?: number;
		cache_creation_input_tokens?: number;
		cache_read_input_tokens?: number;
	};
	// Anthropic-compatible endpoints may report cached prefixes separately
	// (Kimi: input_tokens=0 + cache_read_input_tokens=N on cache hits).
	const inputTokens =
		(usage.input_tokens ?? 0) +
		(usage.cache_creation_input_tokens ?? 0) +
		(usage.cache_read_input_tokens ?? 0);
	return {
		text: content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n"),
		inputTokens,
		outputTokens: usage.output_tokens ?? 0,
	};
}

/** Pick a downgrade fix from a 400 error body; returns null when nothing applicable. */
function pickFix(errorBody: string, fixes: Set<string>): string | null {
	const rules: [RegExp, string][] = [
		[/max_tokens|max completion/i, "max_completion_tokens"],
		[/response_format|json_object/i, "response_format"],
		[/thinking/i, "thinking"],
	];
	for (const [re, fix] of rules) {
		if (re.test(errorBody) && !fixes.has(fix)) return fix;
	}
	return null;
}

/**
 * One LLM call (Anthropic- or OpenAI-compatible) with token accounting and
 * best-effort downgrade: unknown parameters (thinking, response_format,
 * max_tokens vs max_completion_tokens) are retried without on HTTP 400.
 * Throws on unrecoverable errors.
 */
export async function complete(opts: CompleteOptions): Promise<LlmResult> {
	const config = loadConfig();
	const llm = resolveLlm(opts.step);
	const { url, headers } = endpointOf(llm);
	const startedAt = Date.now();
	const fixes = new Set<string>();

	let lastError = "";
	for (let attempt = 0; attempt < 3; attempt++) {
		const body = buildBody(llm, opts, fixes);
		const res = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(opts.timeoutMs ?? llm.requestTimeoutMs),
		});

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			lastError = `HTTP ${res.status} ${text.slice(0, 300)}`;
			if (res.status === 400) {
				const fix = pickFix(text, fixes);
				if (fix) {
					fixes.add(fix);
					continue;
				}
			}
			throw new Error(`LLM request failed: ${lastError}`);
		}

		const data = (await res.json()) as Record<string, unknown>;
		const { text, inputTokens, outputTokens } = parseResponse(llm, data);
		const latencyMs = Date.now() - startedAt;

		const at = new Date().toISOString();
		try {
			logTokens(getDb(config.dbPath), {
				runId: opts.runId,
				step: opts.step,
				sessionFile: opts.sessionFile,
				model: llm.model,
				input: inputTokens,
				output: outputTokens,
				latencyMs,
			});
		} catch {
			// Token logging must never break a run.
		}
		appendUsageLog({
			at,
			run_id: opts.runId,
			step: opts.step,
			session_file: opts.sessionFile,
			protocol: llm.protocol,
			model: llm.model,
			input_tokens: inputTokens,
			output_tokens: outputTokens,
			latency_ms: latencyMs,
			downgrades: fixes.size > 0 ? [...fixes] : undefined,
		});

		return { text, inputTokens, outputTokens };
	}
	throw new Error(`LLM request failed after downgrades: ${lastError}`);
}
