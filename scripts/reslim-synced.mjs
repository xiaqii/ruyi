#!/usr/bin/env node
/**
 * reslim-synced.mjs — one-off maintenance: re-slim files already stored under
 * data/synced/<machine>/ with the CURRENT slim rules (imports the real
 * slimLine from examples/sync-sessions.mjs, so client and server can never
 * drift apart). Line count is preserved exactly — the sync line-index
 * invariant and the client's state file stay valid.
 *
 * Use when: stored files were pushed before a slimming fix (e.g. v2.3.1 added
 * the CC top-level `toolUseResult` base64-image strip — one such field alone
 * was 387KB and dominated a whole machine's volume).
 *
 * SAFETY: never run on files the dream has already processed — distill_state
 * byte offsets refer to the stored bytes. This script rewrites every line's
 * content, so offsets must be remapped afterwards (or the files must be
 * unprocessed). Prints per-file line counts so you can verify 1:1.
 *
 * Usage: node scripts/reslim-synced.mjs <dir> [--agent claude-code]
 */

import { readdirSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { slimLine } from "../examples/sync-sessions.mjs";

const dir = process.argv[2];
if (!dir) {
	console.error("usage: node scripts/reslim-synced.mjs <dir> [--agent claude-code]");
	process.exit(1);
}
const aIdx = process.argv.indexOf("--agent");
const agent = aIdx > 0 ? process.argv[aIdx + 1] : "claude-code";

let totalBefore = 0, totalAfter = 0;
for (const name of readdirSync(dir)) {
	if (!name.endsWith(".jsonl")) continue;
	const file = join(dir, name);
	const before = statSync(file).size;
	const buf = readFileSync(file);
	const tmp = `${file}.reslim`;
	const out = [];
	let start = 0, lines = 0;
	for (let i = 0; i < buf.length; i++) {
		if (buf[i] !== 10) continue;
		const ln = buf.subarray(start, i).toString("utf8");
		start = i + 1;
		lines++;
		let obj;
		try {
			obj = JSON.parse(ln);
		} catch {
			out.push(ln); // unparseable lines pass through verbatim
			continue;
		}
		out.push(JSON.stringify(slimLine(obj, agent)));
	}
	if (start < buf.length) out.push(buf.subarray(start).toString("utf8")); // trailing partial line, untouched
	writeFileSync(tmp, out.join("\n") + (out.length ? "\n" : ""));
	const after = statSync(tmp).size;
	renameSync(tmp, file);
	totalBefore += before;
	totalAfter += after;
	console.log(`${name}: ${lines} 行 (in=out=${lines}) ${(before / 1e6).toFixed(1)}MB → ${(after / 1e6).toFixed(1)}MB`);
}
console.log(`TOTAL: ${(totalBefore / 1e6).toFixed(1)}MB → ${(totalAfter / 1e6).toFixed(1)}MB`);
