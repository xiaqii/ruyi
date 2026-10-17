import { existsSync, readFileSync, mkdirSync, copyFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./types.ts";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Where writable state lives (data/ logs/ profiles/ config.local.json).
 *
 * Git installs keep state inside the repo — zero migration for existing users.
 * npm global installs live in node_modules: read-only-ish, and `npm update`
 * wipes the directory. There we keep state in ~/.ruyi instead. Detection is
 * by presence of the repo's own state; install.sh always creates
 * config.local.json at the project root before serving, so an installed git
 * checkout never falls through to ~/.ruyi.
 * RUYI_STATE env overrides everything (Docker mounts /data, etc.).
 */
const envState = process.env.RUYI_STATE;
const hasProjectState =
	existsSync(resolve(PROJECT_ROOT, "config.local.json")) || existsSync(resolve(PROJECT_ROOT, "data"));
export const STATE_ROOT = envState
	? resolve(envState)
	: hasProjectState
		? PROJECT_ROOT
		: resolve(homedir(), ".ruyi");

function expandPath(p: string): string {
	const expanded = p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p;
	return isAbsolute(expanded) ? expanded : resolve(STATE_ROOT, expanded);
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** Merge config.example.json defaults with config.local.json (or config.json) overrides, one level deep. */
export function loadConfig(): Config {
	const examplePath = resolve(PROJECT_ROOT, "config.example.json");
	const localPath = [
		resolve(PROJECT_ROOT, "config.local.json"),
		resolve(PROJECT_ROOT, "config.json"),
		resolve(STATE_ROOT, "config.local.json"),
	].find(existsSync);

	const base = readJson(examplePath);
	const override = localPath ? readJson(localPath) : {};

	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		if (value && typeof value === "object" && !Array.isArray(value) && typeof merged[key] === "object" && merged[key] !== null) {
			merged[key] = { ...(merged[key] as Record<string, unknown>), ...(value as Record<string, unknown>) };
		} else {
			merged[key] = value;
		}
	}

	const config = merged as unknown as Config;
	config.dbPath = expandPath(config.dbPath);
	for (const s of config.sessions) s.dir = expandPath(s.dir);
	config.llm.baseUrl = config.llm.baseUrl.replace(/\/+$/, "");

	if (!localPath) {
		if (STATE_ROOT !== PROJECT_ROOT) {
			// npm 安装首次运行：把模板落到 ~/.ruyi/config.local.json，改完 key 就能跑。
			mkdirSync(STATE_ROOT, { recursive: true });
			const target = resolve(STATE_ROOT, "config.local.json");
			copyFileSync(examplePath, target);
			chmodSync(target, 0o600);
			console.warn(`[ruyi] no config found — template written to ${target}`);
			console.warn("[ruyi] edit it (llm.apiKey at minimum), then run: ruyi doctor");
		} else {
			console.warn(`[ruyi] no config.local.json found, using config.example.json defaults`);
		}
	}
	return config;
}
