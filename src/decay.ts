import type { DatabaseSync } from "node:sqlite";
import { archiveMemory, logMemoryAction } from "./db.ts";
import type { Config } from "./types.ts";

/**
 * Archive stale agent-inferred memories. User-stated facts never decay;
 * low-confidence inferences that were never reinforced expire.
 */
export function runDecay(db: DatabaseSync, config: Config): number {
	const cutoff = new Date(Date.now() - config.decay.inferredArchiveDays * 86_400_000).toISOString();
	const stale = db
		.prepare(
			`SELECT id FROM memories
			 WHERE status = 'active' AND pinned = 0
			 AND origin = 'agent_inferred'
			 AND confidence < ?
			 AND last_seen_at < ?`,
		)
		.all(config.decay.inferredArchiveConfidenceBelow, cutoff) as unknown as { id: number }[];

	// Go through archiveMemory so decayed entries also leave a forget
	// tombstone — without it the same stale inference could be re-distilled
	// from old logs and resurrect the night it expired.
	for (const { id } of stale) {
		archiveMemory(db, id, "decay");
		logMemoryAction(db, null, "ARCHIVE", { id, reason: "decay" });
	}
	return stale.length;
}
