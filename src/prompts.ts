/** prompts.ts — prompt loading: reads prompts/*.md live from disk on every call, so prompt edits need no restart. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "./config.ts";

export function loadPrompt(name: string): string {
	return readFileSync(resolve(PROJECT_ROOT, "prompts", `${name}.md`), "utf8");
}
