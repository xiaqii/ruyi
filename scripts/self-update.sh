#!/usr/bin/env bash
# ruyi self-update — daily, safe, boring.
#
# Updates ONLY to the latest release tag (every tag passed the full release
# pipeline: tsc + zero-LLM smoke + LLM smoke). After pulling it re-verifies
# locally (tsc + smoke against the restarted service) and rolls back on any
# failure. Never touches config.local.json, data/, logs/, profiles/ (all
# gitignored). Refuses to run on a dirty tree or a non-git install.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

LOG="$ROOT/logs/self-update.log"
STATUS="$ROOT/logs/self-update.status"
LOCK="$ROOT/logs/self-update.lock"
mkdir -p "$ROOT/logs"

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

# single run at a time
if [ -f "$LOCK" ] && [ "$(( $(date +%s) - $(stat -c %Y "$LOCK") ))" -lt 3600 ]; then exit 0; fi
trap 'rm -f "$LOCK"' EXIT
touch "$LOCK"

finish() { # finish <state> <message>
	printf '{"at":"%s","state":"%s","version":"%s","note":%s}\n' \
		"$(date -u +%FT%TZ)" "$1" "$(git describe --tags 2>/dev/null || echo '?')" \
		"$(node -e "console.log(JSON.stringify(process.argv[1]))" "$2")" > "$STATUS"
	log "$1: $2"
}

[ -d .git ] || { finish error "not a git install — update manually"; exit 1; }
[ -z "$(git status --porcelain -- . ':!logs')" ] || { finish skipped "dirty working tree — refusing to auto-update"; exit 0; }

restart_service() {
	if command -v systemctl >/dev/null 2>&1 && systemctl cat ruyi.service >/dev/null 2>&1; then
		systemctl restart ruyi.service
	else
		pkill -f "cli.ts serve" 2>/dev/null || true
		sleep 1
		nohup node "$ROOT/src/cli.ts serve" >> "$ROOT/logs/serve.log" 2>&1 &
	fi
	sleep 2
}

git fetch --tags --quiet origin 2>>"$LOG" || { finish error "git fetch failed (network?)"; exit 1; }
LATEST="$(git tag --sort=-v:refname | head -1)"
CURRENT="$(git describe --tags 2>/dev/null || echo none)"
[ -n "$LATEST" ] || { finish error "no tags found"; exit 1; }
[ "$CURRENT" = "$LATEST" ] && exit 0   # already latest, exit silently

# safety: main must point exactly at the latest tag (release discipline:
# every push to main is a tagged release). Otherwise someone pushed
# unreleased commits — don't auto-eat them.
MAIN_TAG="$(git describe --exact-tags origin/main 2>/dev/null || echo none)"
[ "$MAIN_TAG" = "$LATEST" ] || { finish skipped "origin/main ($MAIN_TAG) is not the latest tag ($LATEST) — unreleased commits on main, refusing"; exit 0; }

OLD_REF="$(git rev-parse HEAD)"
log "updating $CURRENT → $LATEST"
git merge --ff-only "origin/main" >>"$LOG" 2>&1 || { finish error "fast-forward failed"; exit 1; }

# deps may have changed
if git diff --name-only "$OLD_REF" HEAD | grep -q '^package.json$'; then
	npm install --no-fund --no-audit >>"$LOG" 2>&1 || log "WARN: npm install failed"
fi

# gate 1: typecheck
if ! npx tsc --noEmit >>"$LOG" 2>&1; then
	git reset --hard "$OLD_REF" >>"$LOG" 2>&1; restart_service
	finish rolled-back "tsc failed on $LATEST — rolled back to $CURRENT"
	exit 1
fi

restart_service

# gate 2: zero-LLM smoke against the restarted service
if ! node test/smoke.ts >>"$LOG" 2>&1; then
	git reset --hard "$OLD_REF" >>"$LOG" 2>&1; restart_service
	finish rolled-back "smoke tests failed on $LATEST — rolled back to $CURRENT"
	exit 1
fi

finish updated "$CURRENT → $LATEST (tsc + smoke green, service restarted)"
