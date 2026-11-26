#!/usr/bin/env bash
# ruyi release pipeline — every push to GitHub goes through this.
# Usage: bash scripts/release.sh <patch|minor|major> "release note line"
#
# Gate order: typecheck → smoke (zero-LLM E2E) → LLM smoke (cheap) →
# version bump + CHANGELOG → commit → tag → push. Any failure aborts.
# Privacy screening is NOT here — it lives in the machine-wide pre-commit
# hook (privacy gate), which gates every
# commit on this box with string scans + LLM review (fail-closed).
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
# keep the lockfile version in step (it drifted to 0.2.0 once and showed as a fossil)
node -e "const fs=require('fs');const l=JSON.parse(fs.readFileSync('package-lock.json'));l.version='$NEW';if(l.packages&&l.packages[''])l.packages[''].version='$NEW';fs.writeFileSync('package-lock.json',JSON.stringify(l,null,2)+'\n')"
say "version $OLD → $NEW"

# 5. CHANGELOG (values via env: interpolating $NOTE into JS source breaks on apostrophes)
DATE="$(date +%Y-%m-%d)"
NEW="$NEW" DATE="$DATE" NOTE="$NOTE" node -e "
const fs=require('fs');
const cl=fs.existsSync('CHANGELOG.md')?fs.readFileSync('CHANGELOG.md','utf8'):'# CHANGELOG\n';
const entry='## ['+process.env.NEW+'] - '+process.env.DATE+'\n\n- '+process.env.NOTE+'\n';
const idx=cl.indexOf('\n## ');
fs.writeFileSync('CHANGELOG.md', idx===-1 ? cl.trimEnd()+'\n\n'+entry : cl.slice(0,idx+1)+entry+cl.slice(idx+1));
"


# 6. commit + tag + push
git add package.json package-lock.json CHANGELOG.md
# commit message carries no version number (GitHub's file list shows it per file);
# the version lives in the tag and CHANGELOG
git commit -q -m "release: $NOTE"
git tag -a "v$NEW" -m "v$NEW: $NOTE"

# 6b. The public branch is always "main". Production may run on a local
#     long-lived branch (experimental work never gets pushed); in that case the
#     release commits — and only those — are carried onto main via a throwaway
#     worktree, and the tag is re-pointed at main's commit. Pushing the working
#     branch itself would publish the experiments.
RELEASE_BRANCH="$(git branch --show-current)"
if [ -n "$RELEASE_BRANCH" ] && [ "$RELEASE_BRANCH" != "main" ]; then
	say "carrying release onto main from '$RELEASE_BRANCH'"
	# The previous release tag on the working branch is the authoritative "main
	# already has everything up to here" mark. The two branches share history in
	# different shapes (merges, squashes), so patch-identity heuristics misfire;
	# the tag range is exact. Non-merge commits only — merges carry nothing new.
	# Tags are re-pointed at main's commits (step 6c), so they are NOT reachable
	# from the working branch — "previous release" must be read from main.
	# The working-branch commit that produced the previous release is found by
	# its release subject; everything after it on this branch is what main lacks.
	PREV_ON_MAIN="$(git tag --sort=-v:refname --merged main | grep -v "^v$NEW$" | head -1)"
	[ -n "$PREV_ON_MAIN" ] || { say "no previous release tag on main — carry onto main manually"; exit 1; }
	# PREV_HERE = the working-branch commit that produced that release. Tags are
	# re-pointed at main's commits and release subjects drift during manual
	# recovery, so neither the tag object nor subject matching is reliable.
	# The CHANGELOG heading "## [X.Y.Z]" is introduced exactly once, by that
	# release's version-bump commit — pickaxe finds it deterministically.
	PREV_VER="${PREV_ON_MAIN#v}"
	PREV_HERE="$(git log --format=%H -S"## [$PREV_VER]" -- CHANGELOG.md HEAD | head -1)"
	[ -n "$PREV_HERE" ] || { say "cannot locate $PREV_ON_MAIN's CHANGELOG commit on '$RELEASE_BRANCH' — carry onto main manually"; exit 1; }
	RELEASE_COMMITS="$(git rev-list --reverse --no-merges "$PREV_HERE"..HEAD)"
	say "carrying $(echo "$RELEASE_COMMITS" | wc -w | tr -d ' ') commit(s) since $PREV_ON_MAIN"
	[ -n "$RELEASE_COMMITS" ] || { say "nothing to carry onto main"; exit 1; }
	WT="$(mktemp -d /tmp/ruyi-release-main.XXXXXX)"
	git worktree add -q "$WT" main
	# Carry by DIFF, not cherry-pick: the two branches share history in different
	# shapes (squashes, pre-release amalgam commits), so patch application is the
	# robust operation. Conflicts fall back to the working branch's file — its
	# release state is authoritative.
	CARRY_FROM="$(git rev-parse "$PREV_HERE")"
	CARRY_TO="$(git rev-parse HEAD)"
	if ! ( cd "$WT" && git diff "$CARRY_FROM" "$CARRY_TO" -- . ':(exclude)package-lock.json' | git apply --3way - ); then
		say "patch had conflicts — taking the working branch's release files wholesale"
		( cd "$WT" && git checkout --theirs . 2>/dev/null; git checkout "$CARRY_TO" -- . )
	fi
	( cd "$WT" && git add -A && git commit -q -m "release: $NOTE" )
	( cd "$WT" && git tag -f "v$NEW" HEAD >/dev/null && git push -q origin main && git push -q origin "v$NEW" --force )
	MAIN_COMMIT="$(git -C "$WT" rev-parse HEAD)"
	git worktree remove --force "$WT"
	git branch -f main "$MAIN_COMMIT"
	git tag -f "v$NEW" "$MAIN_COMMIT" >/dev/null
else
	git push -q origin main
	git push -q origin "v$NEW" --force
fi

# 7. attach an installable tarball to the GitHub release.
# Why: npm i -g github:… is blocked twice over on npm ≥12 (git fetches need --allow-git,
# install scripts need --allow-scripts) — a prebuilt tarball over https needs neither.
say "pack + upload release asset ruyi.tgz"
rm -f ruyi-*.tgz ruyi.tgz
# Pack from the public commit in a clean worktree: the package must never contain
# files that exist only on the working branch. npm ci is needed for prepack (tsc).
PACK_DIR="$(mktemp -d /tmp/ruyi-release-pack.XXXXXX)"
git worktree add -q "$PACK_DIR" "v$NEW"
( cd "$PACK_DIR" && npm ci --ignore-scripts >/dev/null 2>&1; npm pack >/dev/null && mv ruyi-*.tgz "$OLDPWD/ruyi.tgz" )
git worktree remove --force "$PACK_DIR"
[ -f ruyi.tgz ] || { say "tarball build failed"; exit 1; }
if gh release view "v$NEW" >/dev/null 2>&1; then
	gh release upload "v$NEW" ruyi.tgz --clobber
else
	gh release create "v$NEW" ruyi.tgz --notes "$NOTE"
fi
rm -f ruyi.tgz

# 8. prune old releases (tags stay — they are the version archaeology; the Releases
# page shows only the latest package, per user's taste)
for tag in $(gh release list --limit 100 | awk '{print $1}'); do
	if [ "$tag" != "v$NEW" ]; then
		gh release delete "$tag" --yes >/dev/null 2>&1 && say "pruned old release $tag"
	fi
done

say "released v$NEW and pushed with tag"
say "npm install: npm i -g https://github.com/xiaqii/ruyi/releases/latest/download/ruyi.tgz"
say "NOTE: production deploy (/app/ruyi pull + restart) is a separate, user-confirmed step"
