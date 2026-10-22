#!/usr/bin/env bash
# SMOKE_GATE_COMMIT_SOURCE=http for the two identity scripts: smoke-pair-identity.sh
# freezes and re-checks the commit each service serves at its public URL, and
# smoke-build-identity.sh proves the backend (direct, and through the static
# site's relative /api) by commit plus a configured backend marker. curl, gh and
# render are PATH stubs that log every call, so the Render assertions are on what
# actually ran.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAIR="$SCRIPT_DIR/smoke-pair-identity.sh"
BUILD="$SCRIPT_DIR/smoke-build-identity.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STUB_BIN="$WORK/bin"
mkdir -p "$STUB_BIN" "$WORK/js"
export NET_LOG="$WORK/net.log" RENDER_LOG="$WORK/render.log" STUB_JS_DIR="$WORK/js"
: >"$NET_LOG"
: >"$RENDER_LOG"

cat > "$STUB_BIN/render" <<'STUB'
#!/usr/bin/env bash
printf 'render %s\n' "$*" >>"$RENDER_LOG"
exit 97
STUB
# Serves each invented host from STUB_* env. A health route's status comes
# from STUB_<NAME>_CODE and its curl exit from STUB_<NAME>_EXIT.
cat > "$STUB_BIN/curl" <<'STUB'
#!/usr/bin/env bash
set -u
printf 'curl %s\n' "$*" >>"$NET_LOG"
out=""; fmt=""; fail=false; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) fmt="$2"; shift 2 ;;
    -H|--max-time) shift 2 ;;
    -*f*) fail=true; shift ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
path="${url%%\?*}"
code=200; rc=0; body=""; ctype=text/html
case "$path" in
  *api.render.com/v1/services/*/routes) body='[{"route":{"type":"rewrite","source":"/api/*","destination":"https://api.qa.example.test/*","priority":0}}]' ;;
  *api.render.com/v1/services/*/deploys) printf '[{"deploy":{"id":"dep-render0000001","status":"live","commit":{"id":"%s"}}}]' "$STUB_TIP"; exit 0 ;;
  *api.render.com/v1/services/*) body='{"type":"static_site","serviceDetails":{"url":"https://web.qa.example.test"}}' ;;
  https://web.qa.example.test/version.json)
    body="${STUB_WEB_VERSION-}"; code="${STUB_WEB_VERSION_CODE:-200}"; rc="${STUB_WEB_VERSION_EXIT:-0}" ;;
  https://api.qa.example.test/health)
    body="${STUB_API_HEALTH-}"; code="${STUB_API_HEALTH_CODE:-200}"; rc="${STUB_API_HEALTH_EXIT:-0}" ;;
  https://web.qa.example.test/api/health)
    body="${STUB_PROXY_HEALTH-}"; code="${STUB_PROXY_HEALTH_CODE:-200}"; rc="${STUB_PROXY_HEALTH_EXIT:-0}" ;;
  https://web.qa.example.test/assets/index-ABC123.js) body="$STUB_BUNDLE"; ctype='text/javascript; charset=utf-8' ;;
  https://web.qa.example.test/assets/*.js)
    f="${path##*/}"
    if [ -f "$STUB_JS_DIR/$f" ]; then body="$(cat "$STUB_JS_DIR/$f")"; ctype=application/javascript; else code=404; fi ;;
  https://web.qa.example.test|https://web.qa.example.test/)
    body='<html><head><script type="module" src="/assets/index-ABC123.js"></script></head></html>' ;;
  *) exit 6 ;;
esac
if [ "$fail" = true ] && [ "$code" -ge 400 ]; then exit 22; fi
if [ -n "$out" ]; then printf '%s' "$body" >"$out"; else printf '%s' "$body"; fi
case "$fmt" in *content_type*) printf '%s' "$ctype" ;; ?*) printf '%s' "$code" ;; esac
exit "$rc"
STUB
cat > "$STUB_BIN/gh" <<'STUB'
#!/usr/bin/env bash
printf 'gh %s\n' "$*" >>"$NET_LOG"
case "$*" in
  *api.render.com*) exit 97 ;;
  "api repos/org/repo/commits/"*)
    [ -n "${STUB_RESOLVED_SHA:-}" ] || exit 1
    printf '%s\n' "$STUB_RESOLVED_SHA" ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$STUB_BIN"/*
export PATH="$STUB_BIN:$PATH"

TIP="$(printf 'c%.0s' $(seq 40))"
OLD="$(printf 'd%.0s' $(seq 40))"
export STUB_TIP="$TIP"
QA_MARK='"qa":{"stripeEnabled":false,"commsDeliveryMode":"off"}'
MARKER='.qa.stripeEnabled == false and .qa.commsDeliveryMode == "off"'
fail() { echo "FAIL: $*" >&2; exit 1; }

unset SMOKE_PAIR_FIXTURE_DIR SMOKE_PREVIEW_PROVIDER RENDER_API_KEY SMOKE_GATE_FRONTEND_SERVICE \
  SMOKE_GATE_BACKEND_SERVICE SMOKE_BUILD_ID_FRONTEND_SERVICE 2>/dev/null || true

# ============================ smoke-pair-identity.sh ============================
export SMOKE_GATE_COMMIT_SOURCE=http SMOKE_GATE_REPO=org/repo \
  SMOKE_GATE_BACKEND_COMMIT_URL=https://api.qa.example.test/health \
  SMOKE_GATE_FRONTEND_COMMIT_URL='https://web.qa.example.test/version.json?v=1'
serve() {  # <backend-body> <frontend-body>
  export STUB_API_HEALTH="$1" STUB_WEB_VERSION="$2" STUB_API_HEALTH_EXIT=0 STUB_WEB_VERSION_EXIT=0 \
    STUB_API_HEALTH_CODE=200 STUB_WEB_VERSION_CODE=200
}
pair() { bash "$PAIR" "$@" >"$WORK/out" 2>"$WORK/err"; echo $?; }
expect_rc() { [ "$1" = "$2" ] || fail "$3: expected exit $2, got $1: $(cat "$WORK/out" "$WORK/err")"; }

# P1. Config: http needs both URLs (HTTPS, no whitespace or fragment) and no
#     second identity source; an unknown source is refused.
expect_rc "$(SMOKE_GATE_BACKEND_COMMIT_URL= pair read)" 2 p-missing-url
grep -q 'SMOKE_GATE_BACKEND_COMMIT_URL' "$WORK/err" || fail "p-missing-url: message did not name the knob"
expect_rc "$(SMOKE_GATE_FRONTEND_COMMIT_URL=http://web.qa.example.test/version.json pair read)" 2 p-plain-http
expect_rc "$(SMOKE_GATE_FRONTEND_COMMIT_URL='https://web.qa.example.test/version.json#v' pair read)" 2 p-fragment
expect_rc "$(SMOKE_GATE_BACKEND_COMMIT_URL=$'https://api.qa.example.test/h\nx' pair read)" 2 p-multiline
expect_rc "$(SMOKE_PREVIEW_PROVIDER=static pair read)" 2 p-two-sources
expect_rc "$(SMOKE_GATE_COMMIT_SOURCE=vercel pair read)" 2 p-unknown-source

# P2. start freezes the served commits: URLs as the ids, sha-<commit> as the
#     deploy, commitSource recorded; every read carries a cache buster.
serve "{\"ok\":true,\"commit\":\"$TIP\",$QA_MARK}" "{\"commit\":\"$TIP\"}"
RUN="$WORK/run1"; mkdir -p "$RUN"
expect_rc "$(pair start "$RUN")" 0 p-start
jq -e --arg t "$TIP" '.commitSource == "http" and .ok == true
  and .frontend.service == "https://web.qa.example.test/version.json?v=1" and .frontend.deploy == ("sha-" + $t)
  and .backend.service == "https://api.qa.example.test/health" and .backend.commit == $t' \
  "$RUN/coordinator/identity.json" >/dev/null || fail "p-start: identity.json $(cat "$RUN/coordinator/identity.json")"
grep -Eq 'https://api\.qa\.example\.test/health\?smoke_gate_nocache=[0-9]+' "$NET_LOG" || fail "p-start: backend URL not read with a cache buster"
grep -Eq 'https://web\.qa\.example\.test/version\.json\?v=1&smoke_gate_nocache=[0-9]+' "$NET_LOG" || fail "p-start: frontend URL not read with a cache buster"

# P3. check: unchanged is ok, an abbreviation of the frozen commit is the
#     frozen commit, a moved service is drift; finish reads the journal.
expect_rc "$(pair check "$RUN" lane-a)" 0 p-check-unchanged
serve "{\"commit\":\"${TIP:0:12}\"}" "{\"commit\":\"CCCCCCC\"}"
expect_rc "$(pair check "$RUN" lane-b)" 0 p-check-abbreviated
serve "{\"commit\":\"$TIP\"}" "{\"commit\":\"$TIP\"}"
expect_rc "$(pair finish "$RUN")" 0 p-finish
RUND="$WORK/run-drift"; mkdir -p "$RUND"
expect_rc "$(pair start "$RUND")" 0 p-drift-start
serve "{\"commit\":\"$TIP\"}" "{\"commit\":\"$OLD\"}"
expect_rc "$(pair check "$RUND" moved)" 3 p-check-drift
tail -1 "$RUND/coordinator/identity-checks.ndjson" | jq -e --arg o "$OLD" '.verdict == "drift" and .now.frontend.commit == $o' >/dev/null ||
  fail "p-check-drift: journal"

# P4. An abbreviation that is not the frozen commit resolves through GitHub to
#     a full SHA it prefixes; one that fails to resolve, or resolves to a SHA it
#     does not prefix, is unreadable, never a match.
serve "{\"commit\":\"$TIP\"}" '{"commit":"ddddddd"}'
expect_rc "$(STUB_RESOLVED_SHA="$OLD" pair check "$RUND" resolved)" 3 p-abbrev-resolved
expect_rc "$(pair check "$RUND" unresolved)" 2 p-abbrev-unresolved
expect_rc "$(STUB_RESOLVED_SHA="$TIP" pair check "$RUND" misresolved)" 2 p-abbrev-misresolved

# P5. Unreadable or malformed bodies freeze nothing, even when the other side
#     serves a good commit.
for body in '' '<!doctype html><html></html>' '{"ok":true}' '{"commit":null}' '{"commit":42}' \
            '{"commit":"cccccc"}' "{\"commit\":\"${TIP}c\"}" '{"commit":"not-a-sha"}' \
            "{\"commit\":\"$TIP\"} {\"commit\":\"$TIP\"}" "[{\"commit\":\"$TIP\"}]" "\"$TIP\"" \
            '{"commit":"ccccccc\n"}' '{"commit":"ccccccc\u0000"}' '{"commit":" ccccccc"}' "{\"sha\":\"$TIP\"}"; do
  serve "$body" "{\"commit\":\"$TIP\"}"
  R="$WORK/run-bad"; rm -rf "$R"; mkdir -p "$R"
  expect_rc "$(pair start "$R")" 2 "p-malformed $body"
  [ ! -e "$R/coordinator/identity.json" ] || fail "p-malformed froze a pair: $body"
done
serve "{\"commit\":\"$TIP\"}" "{\"commit\":\"$TIP\"}"
R="$WORK/run-httperr"; mkdir -p "$R"
expect_rc "$(STUB_WEB_VERSION_CODE=503 pair start "$R")" 2 p-http-error

# P6. A run frozen through http keeps reading http with the knob unset; another
#     provider, other ids, or a Render-frozen run under http all refuse.
expect_rc "$(env -u SMOKE_GATE_COMMIT_SOURCE -u SMOKE_GATE_FRONTEND_COMMIT_URL -u SMOKE_GATE_BACKEND_COMMIT_URL \
  bash "$PAIR" check "$RUN" knob-unset >"$WORK/out" 2>"$WORK/err"; echo $?)" 0 p-frozen-source-drives
expect_rc "$(env -u SMOKE_GATE_COMMIT_SOURCE SMOKE_PREVIEW_PROVIDER=static bash "$PAIR" check "$RUN" static \
  >"$WORK/out" 2>"$WORK/err"; echo $?)" 2 p-frozen-http-vs-static
expect_rc "$(env -u SMOKE_GATE_COMMIT_SOURCE SMOKE_GATE_FRONTEND_SERVICE=srv-other00000fe SMOKE_GATE_BACKEND_SERVICE=srv-other00000be \
  bash "$PAIR" check "$RUN" gate-env >"$WORK/out" 2>"$WORK/err"; echo $?)" 2 p-frozen-http-other-ids
expect_rc "$(SMOKE_GATE_BACKEND_COMMIT_URL=https://api.other.example.test/health pair check "$RUN" other-url)" 2 p-other-url
RR="$WORK/run-render"; mkdir -p "$RR/coordinator"
jq -cn --arg t "$TIP" '{frontend:{service:"srv-fe0000000001",deploy:"dep-fe0000000001",commit:$t,status:"live"},
  backend:{service:"srv-be0000000001",deploy:"dep-be0000000001",commit:$t,status:"live"},ok:true,freezeGeneration:1,history:[]}' \
  >"$RR/coordinator/identity.json"
expect_rc "$(env -u SMOKE_GATE_FRONTEND_COMMIT_URL -u SMOKE_GATE_BACKEND_COMMIT_URL bash "$PAIR" check "$RR" render-frozen \
  >"$WORK/out" 2>"$WORK/err"; echo $?)" 2 p-render-frozen-under-http
grep -q 'SMOKE_GATE_COMMIT_SOURCE=http' "$WORK/err" || fail "p-render-frozen-under-http: refused for the wrong reason"
[ ! -e "$RR/coordinator/identity-checks.ndjson" ] || fail "p-render-frozen-under-http: appended a check"

# P7. A PR contract binds both served commits to its sourceSha; a bounded
#     refreeze keeps the http source.
RP="$WORK/run-pr"; mkdir -p "$RP"
jq -cn --arg t "$TIP" '{ownershipKind:"pr",sourceSha:$t}' >"$RP/completion-contract.json"
serve "{\"commit\":\"$OLD\"}" "{\"commit\":\"$TIP\"}"
expect_rc "$(pair start "$RP")" 2 p-pr-source-mismatch
serve "{\"commit\":\"${TIP:0:9}\"}" "{\"commit\":\"$TIP\"}"
expect_rc "$(pair start "$RP")" 0 p-pr-start
jq -e --arg t "$TIP" '.expectedSourceSha == $t and .backend.commit == $t' "$RP/coordinator/identity.json" >/dev/null || fail "p-pr-start"
serve "{\"commit\":\"$OLD\"}" "{\"commit\":\"$OLD\"}"
expect_rc "$(pair refreeze "$RUND" "web redeployed")" 0 p-refreeze
jq -e '.commitSource == "http" and .freezeGeneration == 2 and (.history | length) == 1' "$RUND/coordinator/identity.json" >/dev/null ||
  fail "p-refreeze: $(cat "$RUND/coordinator/identity.json")"

# ============================ smoke-build-identity.sh ============================
FRONTEND=https://web.qa.example.test
BACKEND=https://api.qa.example.test
build_env() {  # <relative|direct>
  export SMOKE_BUILD_ID_EXPECTED_COMMIT="$TIP" SMOKE_BUILD_ID_BACKEND_MARKER="$MARKER" SMOKE_GATE_HEALTH_PATH=/health
  export STUB_API_HEALTH="{\"ok\":true,\"commit\":\"$TIP\",$QA_MARK}" STUB_PROXY_HEALTH="{\"ok\":true,\"commit\":\"$TIP\",$QA_MARK}"
  export STUB_API_HEALTH_CODE=200 STUB_API_HEALTH_EXIT=0 STUB_PROXY_HEALTH_CODE=200 STUB_PROXY_HEALTH_EXIT=0
  unset SMOKE_BUILD_ID_API_BASE STUB_RESOLVED_SHA 2>/dev/null || true
  if [ "$1" = relative ]; then
    export SMOKE_BUILD_ID_API_BASE=/api STUB_BUNDLE='const b="/api";const l=()=>import("./desk-D3sk.js");'
    printf '%s' 'fetch("/api"+"/me")' >"$STUB_JS_DIR/desk-D3sk.js"
  else
    export STUB_BUNDLE='fetch("https://api.qa.example.test/me")'
  fi
}
build() { bash "$BUILD" "$FRONTEND" "$BACKEND" >"$WORK/out" 2>"$WORK/err"; echo $?; }
expect_build() {  # <label> <rc> <jq predicate>
  local rc; rc="$(build)"
  [ "$rc" = "$2" ] || fail "$1: expected exit $2, got $rc: $(cat "$WORK/out" "$WORK/err")"
  jq -e "$3" "$WORK/out" >/dev/null || fail "$1: $(cat "$WORK/out")"
}

# B1. Config: http needs the frozen commit and a marker that compiles, https
#     bases, and a known source; no Render service id or key.
build_env relative
SMOKE_BUILD_ID_EXPECTED_COMMIT= expect_build b-no-commit 2 '.error | test("SMOKE_BUILD_ID_EXPECTED_COMMIT")'
SMOKE_BUILD_ID_BACKEND_MARKER= expect_build b-no-marker 2 '.error | test("SMOKE_BUILD_ID_BACKEND_MARKER")'
SMOKE_BUILD_ID_BACKEND_MARKER='.qa ==' expect_build b-bad-marker 2 '.error | test("SMOKE_BUILD_ID_BACKEND_MARKER")'
SMOKE_GATE_COMMIT_SOURCE=vercel expect_build b-unknown-source 2 '.error | test("SMOKE_GATE_COMMIT_SOURCE")'
RC="$(bash "$BUILD" http://web.qa.example.test "$BACKEND" >"$WORK/out" 2>&1; echo $?)"
[ "$RC" = 2 ] && jq -e '.error | test("https")' "$WORK/out" >/dev/null || fail "b-plain-http: $(cat "$WORK/out")"
RC="$(bash "$BUILD" "$FRONTEND" "$BACKEND?tenant=qa" >"$WORK/out" 2>&1; echo $?)"
[ "$RC" = 2 ] && jq -e '.error | test("query")' "$WORK/out" >/dev/null || fail "b-query-base: $(cat "$WORK/out")"
for hp in '/health#v' '/health?v=1' 'health' '/health/../x y'; do
  SMOKE_GATE_HEALTH_PATH="$hp" expect_build "b-health-path $hp" 2 '.error | test("SMOKE_GATE_HEALTH_PATH")'
done

# B2. Relative: the bundle quotes /api, and the backend and the web origin's
#     /api/health both serve the frozen commit with the marker.
build_env relative
expect_build b-relative-ok 0 '.ok == true and .apiMode == "relative" and .commitSource == "http" and .forwardRoute == null
  and .frontendService == "" and .backendMarker != null and .sameOriginUrl == "https://web.qa.example.test/api/health"'
jq -e --arg t "$TIP" '.backendCommit == $t and .sameOriginCommit == $t' "$WORK/out" >/dev/null || fail "b-relative-ok commits"
grep -Eq 'https://web\.qa\.example\.test/api/health\?smoke_gate_nocache=[0-9]+' "$NET_LOG" || fail "b-relative-ok: no cache buster on the same-origin probe"
grep -Eq 'https://api\.qa\.example\.test/health\?smoke_gate_nocache=[0-9]+' "$NET_LOG" || fail "b-relative-ok: no cache buster on the backend probe"

# B3. Another environment on the same commit (no marker) answering through the
#     web origin, or directly, is not the intended backend.
build_env relative
export STUB_PROXY_HEALTH="{\"ok\":true,\"service\":\"x\",\"commit\":\"$TIP\"}"
expect_build b-proxy-unmarked 1 '.ok == false and (.reason | test("same-origin health .*SMOKE_BUILD_ID_BACKEND_MARKER"))'
build_env relative
export STUB_API_HEALTH="{\"ok\":true,\"commit\":\"$TIP\",\"qa\":{\"stripeEnabled\":true,\"commsDeliveryMode\":\"off\"}}"
expect_build b-backend-unmarked 1 '.ok == false and (.reason | test("backend .*SMOKE_BUILD_ID_BACKEND_MARKER"))'
build_env relative
SMOKE_BUILD_ID_BACKEND_MARKER='true, true' expect_build b-marker-two-outputs 1 '.ok == false and (.reason | test("MARKER"))'
SMOKE_BUILD_ID_BACKEND_MARKER='.qa | length > "x" | not | not and (.qa.a | ascii_downcase)' \
  expect_build b-marker-errors 1 '.ok == false and (.reason | test("MARKER"))'
# A predicate that halts exits 0 with no output; that is no answer, in either mode.
HALTING='if has("qa") then .qa.stripeEnabled == false else halt end'
build_env relative
export STUB_PROXY_HEALTH="{\"ok\":true,\"commit\":\"$TIP\"}"
SMOKE_BUILD_ID_BACKEND_MARKER="$HALTING" expect_build b-marker-halts-relative 1 '.ok == false and (.reason | test("same-origin health .*MARKER"))'
build_env direct
export STUB_API_HEALTH="{\"ok\":true,\"commit\":\"$TIP\"}"
SMOKE_BUILD_ID_BACKEND_MARKER="$HALTING" expect_build b-marker-halts-direct 1 '.ok == false and (.reason | test("MARKER"))'

# B4. Commit binding: another commit, a resolvable or prefix abbreviation, and
#     malformed bodies through the web origin.
build_env relative
export STUB_PROXY_HEALTH="{\"ok\":true,\"commit\":\"$OLD\",$QA_MARK}"
expect_build b-proxy-other-commit 1 '.ok == false and (.reason | test("same-origin health .*not the frozen"))'
build_env relative
export STUB_PROXY_HEALTH="{\"ok\":true,\"commit\":\"${TIP:0:8}\",$QA_MARK}"
expect_build b-proxy-prefix 0 '.ok == true'
build_env relative
export STUB_PROXY_HEALTH="{\"ok\":true,\"commit\":\"ddddddd\",$QA_MARK}"
STUB_RESOLVED_SHA="$OLD" SMOKE_GATE_REPO=org/repo expect_build b-proxy-abbrev-other 1 '.ok == false and (.reason | test("not the frozen"))'
for body in '<!doctype html><html></html>' "{\"commit\":\"$TIP\",$QA_MARK} {\"commit\":\"$TIP\",$QA_MARK}" \
            "{\"commit\":\"ccccccc\\n\",$QA_MARK}" "{\"sha\":\"$TIP\",$QA_MARK}" "{\"ok\":false,\"commit\":\"$TIP\",$QA_MARK}"; do
  build_env relative
  export STUB_PROXY_HEALTH="$body"
  expect_build "b-proxy-malformed $body" 1 '.ok == false and (.reason | test("same-origin health"))'
done
build_env relative
export STUB_PROXY_HEALTH_CODE=502
expect_build b-proxy-502 1 '.ok == false and (.reason | test("same-origin health .*502"))'

# B5. Direct mode under http: the bundle names the backend host, and the
#     backend's own health is commit- and marker-bound.
build_env direct
expect_build b-direct-ok 0 '.ok == true and .apiMode == "direct" and .commitSource == "http" and .expectedHostCount == 1'
build_env direct
export STUB_API_HEALTH="{\"ok\":true,\"commit\":\"$TIP\"}"
expect_build b-direct-unmarked 1 '.ok == false and (.reason | test("SMOKE_BUILD_ID_BACKEND_MARKER"))'
build_env direct
export STUB_API_HEALTH="{\"ok\":true,\"commit\":\"$OLD\",$QA_MARK}"
expect_build b-direct-other-commit 1 '.ok == false and (.reason | test("not the frozen"))'
build_env direct
export STUB_API_HEALTH_CODE=503
expect_build b-direct-down 1 '.ok == false and .backendReachable == false'

# ================================ Render detector ================================
# Nothing above reached Render: no render CLI, no api.render.com from any tool.
[ ! -s "$RENDER_LOG" ] || fail "render CLI ran: $(cat "$RENDER_LOG")"
if grep -q 'api\.render\.com' "$NET_LOG"; then fail "Render API called under http: $(grep 'api\.render\.com' "$NET_LOG" | head -3)"; fi
grep -q '^curl ' "$NET_LOG" || fail "no curl recorded: the stub is not on PATH"

# The detector is live: the default source does call the Render API, in both scripts.
: >"$NET_LOG"
env -u SMOKE_GATE_COMMIT_SOURCE RENDER_API_KEY=k SMOKE_GATE_FRONTEND_SERVICE=srv-fe0000000001 \
  SMOKE_GATE_BACKEND_SERVICE=srv-be0000000001 bash "$PAIR" read >/dev/null 2>&1 || true
grep -q 'api\.render\.com/v1/services/srv-fe0000000001/deploys' "$NET_LOG" || fail "render pair source did not read the deploys API"
: >"$NET_LOG"
build_env relative
env -u SMOKE_GATE_COMMIT_SOURCE RENDER_API_KEY=k SMOKE_BUILD_ID_FRONTEND_SERVICE=srv-web0000000001 \
  bash "$BUILD" "$FRONTEND" "$BACKEND" >/dev/null 2>&1 || true
grep -q 'api\.render\.com/v1/services/srv-web0000000001/routes' "$NET_LOG" || fail "render build source did not read the routes API"

echo "smoke-identity-commit-source: ok"
