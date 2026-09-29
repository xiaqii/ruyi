export type MemoryKind = "preference" | "fact" | "project" | "lesson" | "skill_index";
export type MemoryOrigin = "user_stated" | "agent_inferred" | "mixed";
export type MemoryStatus = "active" | "superseded" | "archived";

export interface MemoryRow {
	id: number;
	owner: string;
	cwd: string | null;
	kind: MemoryKind;
	domain: string | null;
	summary: string;
	content: string;
	origin: MemoryOrigin;
	confidence: number;
	evidence: number;
	source: string | null;
	pinned: number;
	status: MemoryStatus;
	superseded_by: number | null;
	created_at: string;
	updated_at: string;
	last_seen_at: string;
}

export interface Candidate {
	kind: MemoryKind;
	domain?: string;
	summary: string;
	content: string;
	origin: MemoryOrigin;
	confidence: number;
	quote?: string;
}

export type MergeAction =
	| { action: "NEW"; candidate: Candidate }
	| { action: "REINFORCE"; id: number; candidate: Candidate }
	| { action: "REFINE"; id: number; summary?: string; content: string; candidate: Candidate }
	| { action: "SUPERSEDE"; id: number; summary: string; content: string; kind?: MemoryKind; domain?: string; candidate: Candidate };

export interface SessionSourceConfig {
	agent: string;
	dir: string;
	/** Isolation boundary: sessions under this dir feed memories of this owner. */
	owner?: string;
}

export interface Config {
	host: string;
	port: number;
	dbPath: string;
	sessions: SessionSourceConfig[];
	llm: {
		baseUrl: string;
		apiKey: string;
		model: string;
		maxTokens: number;
		requestTimeoutMs: number;
	};
	dream: {
		pipeline: "full" | "single";
		minDeltaChars: number;
		maxSessionChars: number;
		mergeSummaryLimit: number;
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
