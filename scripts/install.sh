#!/usr/bin/env bash
# ruyi (如忆) installer — designed to be run BY an agent (see AGENT.README.md)
# or a human. Idempotent: safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

say() { printf '\033[1m[ruyi install]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[ruyi install] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

DREAM=0; AUTO_UPDATE=0
for a in "$@"; do case "$a" in --dream) DREAM=1;; --with-auto-update) AUTO_UPDATE=1;; esac; done

# 1. Node >= 23.6 (native TS + node:sqlite)
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || fail "node not found. Install Node.js >= 23.6 first."
NODE_VER="$("$NODE_BIN" -e 'console.log(process.versions.node)')"
NODE_MAJOR="${NODE_VER%%.*}"
[ "$NODE_MAJOR" -ge 23 ] || fail "node $NODE_VER too old (need >= 23.6). Upgrade Node.js."
say "node $NODE_VER OK"

# 2. Dependencies (dev-only: typescript)
if [ ! -d node_modules ]; then
	say "npm install (dev-only deps)"
	npm install --no-fund --no-audit
fi

# 3. Config
if [ ! -f config.local.json ]; then
	cp config.example.json config.local.json
	say "created config.local.json from example — EDIT IT: llm.baseUrl / apiKey / model, sessions dirs"
	CONFIG_FRESH=1
else
	CONFIG_FRESH=0
fi
chmod 600 config.local.json

# 4. Session dirs sanity (warn only)
"$NODE_BIN" --no-warnings --input-type=module -e "
import { loadConfig } from './src/config.ts';
import { existsSync } from 'node:fs';
const c = loadConfig();
for (const s of c.sessions) if (!existsSync(s.dir)) console.log('[ruyi install] WARN: session dir missing: ' + s.dir);
" || true

# 5. Service: systemd when available+permitted, else print nohup fallback
if command -v systemctl >/dev/null 2>&1 && [ -d /etc/systemd/system ] && [ -w /etc/systemd/system ]; then
	NODE_PATH="$NODE_BIN" ROOT_PATH="$ROOT" envsubst < systemd/ruyi.service.template > /etc/systemd/system/ruyi.service 2>/dev/null || \
	sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__ROOT__|$ROOT|g" systemd/ruyi.service.template > /etc/systemd/system/ruyi.service
	sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__ROOT__|$ROOT|g" systemd/ruyi-dream.service.template > /etc/systemd/system/ruyi-dream.service
	cp systemd/ruyi-dream.timer /etc/systemd/system/
	systemctl daemon-reload
	systemctl enable --now ruyi.service ruyi-dream.timer
	say "systemd: ruyi.service + ruyi-dream.timer enabled"
else
	say "no writable systemd — start manually:"
	say "  nohup $NODE_BIN $ROOT/src/cli.ts serve >> $ROOT/logs/serve.log 2>&1 &"
	say "  nightly dream via cron: 20 3 * * * $NODE_BIN $ROOT/src/cli.ts distill >> $ROOT/logs/dream.log 2>&1"
	mkdir -p logs
fi

# 5b. Optional daily self-update (release tags only, smoke-gated, auto-rollback)
chmod +x scripts/self-update.sh
if [ "$AUTO_UPDATE" = "1" ]; then
	( crontab -l 2>/dev/null | grep -v "scripts/self-update.sh"; echo "40 4 * * * $ROOT/scripts/self-update.sh >/dev/null 2>&1" ) | crontab -
	say "daily self-update cron installed (04:40; latest release tag only, tsc+smoke gated, auto-rollback)"
else
	say "optional: daily self-update → re-run with --with-auto-update"
fi

# 6. First dream is opt-in (it costs LLM tokens): run only with --dream
if [ "$DREAM" = "1" ]; then
	say "running first dream (initialMaxDays applies)..."
	"$NODE_BIN" src/cli.ts distill || true
fi

# 7. Doctor
say "running doctor..."
"$NODE_BIN" src/cli.ts doctor

[ "$CONFIG_FRESH" = "0" ] || say "REMINDER: config.local.json still has the example API key — edit it, then: node src/cli.ts doctor"
say "done."
