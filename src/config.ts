import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./types.ts";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function expandPath(p: string): string {
	const expanded = p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p;
	return isAbsolute(expanded) ? expanded : resolve(PROJECT_ROOT, expanded);
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** Merge config.example.json defaults with config.local.json (or config.json) overrides, one level deep. */
export function loadConfig(): Config {
	const examplePath = resolve(PROJECT_ROOT, "config.example.json");
	const localPath = [resolve(PROJECT_ROOT, "config.local.json"), resolve(PROJECT_ROOT, "config.json")].find(existsSync);

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
		console.warn(`[ruyi] no config.local.json found, using config.example.json defaults`);
	}
	return config;
}
