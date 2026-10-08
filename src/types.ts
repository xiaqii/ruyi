export type MemoryKind = "preference" | "fact" | "knowledge" | "lesson" | "skill_index";
export type MemoryOrigin = "user_stated" | "agent_inferred" | "mixed";
export type MemoryStatus = "active" | "absorbed" | "superseded" | "archived";

export interface MemoryRow {
	id: number;
	owner: string;
	cwd: string | null;
	kind: MemoryKind;
	domain: string | null;
	summary: string;
	content: string;
	/** 3-6 retrieval keywords, space-separated. Indexed in FTS; never shown to the LLM in bulk. */
	keywords: string;
	origin: MemoryOrigin;
	confidence: number;
	evidence: number;
	source: string | null;
	pinned: number;
	status: MemoryStatus;
	superseded_by: number | null;
	/** Profile id that absorbed this memory (status='absorbed'). */
	absorbed_by: number | null;
	created_at: string;
	updated_at: string;
	last_seen_at: string;
}

export interface Candidate {
	kind: MemoryKind;
	domain?: string;
	summary: string;
	content: string;
	keywords?: string[];
	origin: MemoryOrigin;
	confidence: number;
	quote?: string;
}

export type MergeAction =
	| { action: "NEW"; candidate: Candidate }
	| { action: "REINFORCE"; id: number; candidate: Candidate }
	| { action: "REFINE"; id: number; summary?: string; content: string; keywords?: string[]; candidate: Candidate }
	| { action: "SUPERSEDE"; id: number; summary: string; content: string; keywords?: string[]; kind?: MemoryKind; domain?: string; candidate: Candidate };

export interface LlmTierConfig {
	protocol?: "anthropic" | "openai";
	baseUrl?: string;
	apiKey?: string;
	model?: string;
	maxTokens?: number;
	requestTimeoutMs?: number;
	/** "off" = disable thinking (best effort), number = budget tokens, "default" = model default. */
	thinking?: "off" | "default" | number;
}

export interface SessionSourceConfig {
	agent: string;
	dir: string;
	/** Isolation boundary: sessions under this dir feed memories of this owner. */
	owner?: string;
}

export interface Config {
	host: string;
	port: number;
	/** Optional bearer token. Empty = no auth (safe for 127.0.0.1-only deploys).
	 *  Set this when exposing the service beyond localhost. */
	authToken: string;
	dbPath: string;
	sessions: SessionSourceConfig[];
	llm: {
		protocol?: "anthropic" | "openai";
		baseUrl: string;
		apiKey: string;
		model: string;
		maxTokens: number;
		requestTimeoutMs: number;
		thinking?: "off" | "default" | number;
		/** Per-tier overrides: "recall" = understand+rerank (cheap/fast), "dream" = everything else. */
		steps?: { recall?: LlmTierConfig; dream?: LlmTierConfig };
	};
	dream: {
		pipeline: "full" | "single";
		minDeltaChars: number;
		maxSessionChars: number;
		mergeSummaryLimit: number;
		/** Soft store-size target; reorganize gets more aggressive above it. */
		targetSize: number;
		/** First-dream cost control: never-processed session files are only read
		 *  this many bytes back from the tail (0 = read everything). */
		initialMaxBytes: number;
	};
	inject: {
		constitutionMax: number;
		indexMax: number;
		indexDays: number;
		recallK: number;
		recallCandidateDays: number;
		recallCandidateMax: number;
	};
	decay: {
		inferredArchiveDays: number;
		inferredArchiveConfidenceBelow: number;
	};
	recall: {
		defaultScope: "smart" | "cwd" | "all";
	};
}

export interface DreamReport {
	runId: string;
	startedAt: string;
	finishedAt: string;
	sessionsScanned: number;
	sessionsDistilled: number;
	triaged: number;
	new: number;
	reinforced: number;
	refined: number;
	superseded: number;
	archived: number;
	reorganize: {
		owner: string;
		merged: number;
		conflictsResolved: number;
		archived: number;
		retagged: number;
	}[];
	inputTokens: number;
	outputTokens: number;
	errors: string[];
}
