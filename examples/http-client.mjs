/**
 * Minimal ruyi HTTP client — reference for ANY agent/script integration.
 * Zero dependencies (Node 18+ global fetch). Copy these four functions.
 *
 * Contract: see API.md (test-enforced). Timeouts: SQL endpoints 5s;
 * LLM-bound endpoints (recall deep, remember, ingest) >= 45s.
 */

const BASE = (process.env.RUYI_URL ?? "http://127.0.0.1:8899").replace(/\/+$/, "");
const TOKEN = process.env.RUYI_TOKEN ?? ""; // only when the service sets authToken
const OWNER = process.env.RUYI_OWNER ?? "default";

async function api(path, { method = "GET", body, timeoutMs = 5_000 } = {}) {
	const headers = { "content-type": "application/json" };
	if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok) throw new Error(`ruyi ${path}: HTTP ${res.status}`);
	return res.json();
}

// 1. Session-start injection (free, pure SQL): constitution + index + profile directory
export const inject = (cwd = "") =>
	api(`/inject?owner=${OWNER}&cwd=${encodeURIComponent(cwd)}&scope=smart`);

// 2. Recall: mode fast (free) | deep (LLM rerank) | excavate (dig absorbed/archived too)
export const recall = (query, mode = "deep", k = 6) =>
	api("/recall", { method: "POST", body: { query, k, owner: OWNER, mode }, timeoutMs: 45_000 });

// 3. Explicit write ("remember this") — LLM merge judgement, ~10s, keep timeout >= 45s
export const remember = (kind, summary, content, domain) =>
	api("/memories", { method: "POST", body: { kind, summary, content, domain, owner: OWNER }, timeoutMs: 45_000 });

// 4. Usage report
export const stats = (days = 7) => api(`/stats?days=${days}&owner=${OWNER}`);

// Failure isolation is YOUR job: wrap calls in try/catch and never block your
// main work on this service — ruyi down = no memory this turn, nothing more.
