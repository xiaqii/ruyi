#!/usr/bin/env bash
# ruyi release pipeline — every push to GitHub goes through this.
# Usage: bash scripts/release.sh <patch|minor|major> "release note line"
#
# Gate order: typecheck → smoke (zero-LLM E2E) → LLM smoke (cheap) →
# version bump + CHANGELOG → commit → tag → push. Any failure aborts.
set -euo pipefail
cd "$(dirname "$0")/.."

LEVEL="${1:-patch}"
NOTE="${2:-}"
[ -n "$NOTE" ] || { echo "usage: release.sh <patch|minor|major> \"release note\""; exit 1; }

say() { printf '\033[1m[release]\033[0m %s\n' "$*"; }

# 0. working tree must be clean except for what we are about to commit
if [ -n "$(git status --porcelain)" ]; then
	say "committing pending changes first"
	git add -A
	git commit -q -m "chore: pre-release commit" || true
fi

# 1. typecheck — no syntax/type errors ever reach the repo
say "tsc --noEmit"
npx tsc --noEmit

# 2. zero-LLM smoke (schema, FTS, CRUD, HTTP, MCP)
say "smoke tests (no LLM)"
node test/smoke.ts

# 2b. API contract — every endpoint documented in API.md, shape by shape
say "api contract (API.md)"
node test/api-contract.ts

# 3. LLM smoke (both tiers + deep recall + a real write/archive round trip)
say "llm smoke"
node test/llm-smoke.ts

# 4. version bump (semver) in package.json
OLD="$(node -p "require('./package.json').version")"
NEW="$(node -e "const p='$OLD'.split('.').map(Number); const l='$LEVEL';
  if(l==='major'){p[0]++;p[1]=0;p[2]=0}else if(l==='minor'){p[1]++;p[2]=0}else if(l==='patch'){p[2]++}else{process.exit(1)}
  console.log(p.join('.'))" 2>/dev/null || true)"
[ -n "$NEW" ] || { say "bad level: $LEVEL"; exit 1; }
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json'));p.version='$NEW';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
say "version $OLD → $NEW"

# 5. CHANGELOG
DATE="$(date +%Y-%m-%d)"
node -e "
const fs=require('fs');
const cl=fs.existsSync('CHANGELOG.md')?fs.readFileSync('CHANGELOG.md','utf8'):'# CHANGELOG\n';
const entry='## [$NEW] - $DATE\n\n- $NOTE\n';
const idx=cl.indexOf('\n## ');
fs.writeFileSync('CHANGELOG.md', idx===-1 ? cl.trimEnd()+'\n\n'+entry : cl.slice(0,idx+1)+entry+cl.slice(idx+1));
"

# 6. commit + tag + push
git add package.json CHANGELOG.md
git commit -q -m "release: v$NEW — $NOTE"
git tag -a "v$NEW" -m "v$NEW: $NOTE"
git push --follow-tags

say "released v$NEW and pushed with tag"
say "NOTE: production deploy (/app/ruyi pull + restart) is a separate, user-confirmed step"
