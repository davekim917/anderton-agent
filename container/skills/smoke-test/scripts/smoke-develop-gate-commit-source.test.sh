#!/usr/bin/env bash
# SMOKE_GATE_COMMIT_SOURCE=http: each service's deployed commit is read from a
# public URL, every verb runs without touching Render, and only a served
# commit equal to the tip counts as live. gh, curl and render are PATH stubs
# that log every call, so the Render assertions are on what actually ran.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$SCRIPT_DIR/smoke-develop-gate.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STUB_BIN="$WORK/bin"
STATE_DIR="$WORK/state"
mkdir -p "$STUB_BIN" "$STATE_DIR" "$WORK/shared"
export NET_LOG="$WORK/net.log" RENDER_LOG="$WORK/render.log"
: >"$NET_LOG"
: >"$RENDER_LOG"

cat > "$STUB_BIN/mountpoint" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = "-q" ] && [ "${2:-}" = "${SMOKE_GATE_SHARED_ROOT:-}" ]
STUB
cat > "$STUB_BIN/render" <<'STUB'
#!/usr/bin/env bash
printf 'render %s\n' "$*" >>"$RENDER_LOG"
exit 97
STUB
cat > "$STUB_BIN/curl" <<'STUB'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"$NET_LOG"
case "$*" in
  *api.render.com*)
    printf '[{"status":"live","commit":{"id":"%s"}}]' "$STUB_SOURCE_SHA" ;;
  *backend.example.test*)
    printf '%s' "${STUB_BACKEND_BODY-}"; exit "${STUB_BACKEND_EXIT:-0}" ;;
  *frontend.example.test*)
    printf '%s' "${STUB_FRONTEND_BODY-}"; exit "${STUB_FRONTEND_EXIT:-0}" ;;
  *) exit 6 ;;
esac
STUB
cat > "$STUB_BIN/gh" <<'STUB'
#!/usr/bin/env bash
printf 'gh %s\n' "$*" >>"$NET_LOG"
case "$*" in
  *api.render.com*) exit 97 ;;
  *"/statuses/"*) echo '{}'; exit 0 ;;
esac
case "$1 $2" in
  "pr list") exit 0 ;;
  "api repos/org/repo/branches/develop") printf '{"commit":{"sha":"%s"}}' "$STUB_SOURCE_SHA" ;;
  "run list")
    printf '[{"headSha":"%s","status":"completed","conclusion":"success","workflowName":"CI"}]' "$STUB_SOURCE_SHA" ;;
  *)
    case "$2" in
      */activity\?*) echo '{}' ;;
      */compare/*) printf '{"status":"ahead","behind_by":0,"files":[]}' ;;
      */commits/*)
        [ -n "${STUB_RESOLVED_SHA:-}" ] || exit 1
        printf '%s\n' "$STUB_RESOLVED_SHA" ;;
      *) echo '{}' ;;
    esac ;;
esac
STUB
chmod +x "$STUB_BIN"/*
export PATH="$STUB_BIN:$PATH"

unset SMOKE_GATE_BACKEND_SERVICE SMOKE_GATE_FRONTEND_SERVICE 2>/dev/null || true
export SMOKE_GATE_STATE_DIR="$STATE_DIR" SMOKE_GATE_SHARED_ROOT="$WORK/shared" \
  SMOKE_GATE_LEASE_DIR="$WORK/shared/leases" SMOKE_CONTROLLER_ENV_FILE="$WORK/none.env" \
  SMOKE_GATE_REPO=org/repo SMOKE_GATE_DEV_URL=https://app.frontend.example.test \
  SMOKE_GATE_DEBOUNCE_SECONDS=0 SMOKE_GATE_COMMIT_SOURCE=http \
  SMOKE_GATE_BACKEND_COMMIT_URL=https://api.backend.example.test/health \
  SMOKE_GATE_FRONTEND_COMMIT_URL='https://app.frontend.example.test/version.json?v=1'

TIP="$(printf 'c%.0s' $(seq 40))"
OLD="$(printf 'd%.0s' $(seq 40))"
export STUB_SOURCE_SHA="$TIP"
serve() {  # <backend-body> <frontend-body>
  export STUB_BACKEND_BODY="$1" STUB_FRONTEND_BODY="$2" STUB_BACKEND_EXIT=0 STUB_FRONTEND_EXIT=0
}
fail() { echo "FAIL: $*" >&2; exit 1; }

# 1. Config: http needs both URLs (HTTPS, no whitespace, no fragment, which
#    would swallow the cache buster), not the Render ids;
#    an unknown source is named.
OUT="$(SMOKE_GATE_BACKEND_COMMIT_URL= SMOKE_GATE_FRONTEND_COMMIT_URL='http://plain.example.test/v' bash "$GATE" config)" && fail "config passed without URLs"
jq -e '.missing == ["SMOKE_GATE_BACKEND_COMMIT_URL","SMOKE_GATE_FRONTEND_COMMIT_URL"]' <<<"$OUT" >/dev/null || fail "config missing: $OUT"
OUT="$(SMOKE_GATE_BACKEND_COMMIT_URL=$'https://a.example.test/h\nb' bash "$GATE" config)" && fail "config passed a multi-line URL"
jq -e '.missing == ["SMOKE_GATE_BACKEND_COMMIT_URL"]' <<<"$OUT" >/dev/null || fail "multi-line URL: $OUT"
OUT="$(SMOKE_GATE_FRONTEND_COMMIT_URL='https://a.example.test/version.json#v' bash "$GATE" config)" && fail "config passed a URL fragment"
jq -e '.missing == ["SMOKE_GATE_FRONTEND_COMMIT_URL"]' <<<"$OUT" >/dev/null || fail "URL fragment: $OUT"
OUT="$(SMOKE_GATE_COMMIT_SOURCE=vercel bash "$GATE" config)" && fail "config passed an unknown source"
jq -e '.missing == ["SMOKE_GATE_COMMIT_SOURCE"]' <<<"$OUT" >/dev/null || fail "unknown source: $OUT"
bash "$GATE" config | jq -e '.ok == true' >/dev/null || fail "http config without Render ids refused"

# 2. Served commit equals the tip on both services: settled. The read carries
#    a cache-busting parameter, appended with & where the URL has a query.
serve "{\"ok\":true,\"commit\":\"$TIP\"}" "{\"commit\":\"$TIP\"}"
OUT="$(bash "$GATE" check)"
jq -e --arg tip "$TIP" '.settled == true and .deployReady == true and .commitSource == "http" and
  .backendDeploySha == $tip and .frontendDeploySha == $tip' <<<"$OUT" >/dev/null || fail "matching check: $OUT"
grep -Eq 'https://api\.backend\.example\.test/health\?smoke_gate_nocache=[0-9]+' "$NET_LOG" || fail "backend URL not read"
grep -Eq 'https://app\.frontend\.example\.test/version\.json\?v=1&smoke_gate_nocache=[0-9]+' "$NET_LOG" || fail "frontend URL not read"

# 3. An abbreviated served commit that prefixes the tip is the tip (case-insensitive).
serve "{\"commit\":\"CCCCCCC\"}" "{\"commit\":\"${TIP:0:12}\"}"
bash "$GATE" check | jq -e --arg tip "$TIP" '.settled == true and .backendDeploySha == $tip' >/dev/null || fail "abbreviated prefix"

# 4. A deploy that has not gone live (in progress, or failed and rolled back)
#    still serves the old commit: reported, never settled.
serve "{\"commit\":\"$OLD\"}" "{\"commit\":\"$TIP\"}"
OUT="$(bash "$GATE" check)"
jq -e --arg old "$OLD" '.ok == true and .settled == false and .deployReady == false and
  .backendDeploySha == $old' <<<"$OUT" >/dev/null || fail "lagging deploy: $OUT"

# 4b. The opt-in path-scoped lag rule applies to a served commit exactly as it
#     does to a Render live deploy: with SMOKE_GATE_BACKEND_PATHS set and no
#     backend path changed since the served commit, the lag is accepted.
SMOKE_GATE_BACKEND_PATHS=api/ bash "$GATE" check | jq -e --arg old "$OLD" '.settled == true and
  .backendDeploySha == $old and .deployLagAccepted.backend == true' >/dev/null || fail "lag rule under http"

# 5. An abbreviated commit that is not the tip is resolved through GitHub to a
#    full SHA it prefixes; a resolution that fails or disagrees is unknown.
serve '{"commit":"ddddddd"}' "{\"commit\":\"$TIP\"}"
STUB_RESOLVED_SHA="$OLD" bash "$GATE" check | jq -e --arg old "$OLD" '.settled == false and .backendDeploySha == $old' >/dev/null || fail "resolved abbreviation"
bash "$GATE" check | jq -e '.ok == false and .data.trigger == "gate_fetch_failed"' >/dev/null || fail "unresolvable abbreviation"
STUB_RESOLVED_SHA="$TIP" bash "$GATE" check | jq -e '.ok == false and .data.trigger == "gate_fetch_failed"' >/dev/null || fail "resolution to a non-matching SHA"

# 6. Unreadable or malformed bodies are unknown, never a match — even when the
#    other service serves the tip.
for body in '' '<!doctype html><html></html>' '{"ok":true}' '{"commit":null}' '{"commit":42}' \
            '{"commit":"cccccc"}' "{\"commit\":\"${TIP}c\"}" '{"commit":"not-a-sha"}' \
            "{\"commit\":\"$TIP\"} {\"commit\":\"$TIP\"}" "[{\"commit\":\"$TIP\"}]" "\"$TIP\"" \
            '{"commit":"ccccccc\n"}' '{"commit":"ccccccc\n\n"}' '{"commit":"ccccccc\u0000"}' '{"commit":" ccccccc"}'; do
  serve "$body" "{\"commit\":\"$TIP\"}"
  bash "$GATE" check | jq -e '.ok == false and .settled == false and .data.trigger == "gate_fetch_failed"' >/dev/null ||
    fail "malformed backend body read as known: $body"
done
serve "{\"commit\":\"$TIP\"}" "{\"commit\":\"$TIP\"}"
export STUB_FRONTEND_EXIT=22
bash "$GATE" check | jq -e '.ok == false and .data.trigger == "gate_fetch_failed"' >/dev/null || fail "HTTP error read as known"
export STUB_FRONTEND_EXIT=0

# 7. wait-settled on a deploy that never goes live times out, it does not pass.
serve "{\"commit\":\"$TIP\"}" "{\"commit\":\"$OLD\"}"
set +e
OUT="$(SMOKE_GATE_WAIT_MAX_SECONDS=0 bash "$GATE" wait-settled)"
RC=$?
set -e
[ "$RC" -eq 1 ] || fail "wait-settled exit $RC"
jq -e '.settled == false and .timedOut == true' <<<"$OUT" >/dev/null || fail "wait-settled: $OUT"

# 8. poll: a never-live deploy waits, then raises the unsettled alarm; once the
#    tip is served the build settles and wakes.
SMOKE_GATE_UNSETTLED_ALERT_SECONDS=3600 bash "$GATE" poll |
  jq -e '.wakeAgent == false and .data.trigger == "waiting_for_settled_build"' >/dev/null || fail "poll did not wait"
SMOKE_GATE_UNSETTLED_ALERT_SECONDS=0 bash "$GATE" poll |
  jq -e --arg old "$OLD" '.wakeAgent == true and .data.trigger == "develop_unsettled" and
    .data.frontendDeploySha == $old and .data.frontendDeployLag == true' >/dev/null || fail "no unsettled alarm"
serve "{\"commit\":\"$TIP\"}" "{\"commit\":\"$TIP\"}"
bash "$GATE" poll | jq -e '.wakeAgent == false and .data.trigger == "debouncing_candidate"' >/dev/null || fail "no debounce"
bash "$GATE" poll | jq -e --arg tip "$TIP" '.wakeAgent == true and .data.trigger == "develop_build_settled" and
  .data.sourceSha == $tip' >/dev/null || fail "no settled wake"
RUN_ID="$(jq -r '.activeRunId' "$STATE_DIR/develop-state.json")"

# 9. The remaining verbs, so every verb has run under http.
bash "$GATE" progress "$RUN_ID" | jq -e '.ok == true' >/dev/null || fail "progress"
bash "$GATE" release "$RUN_ID" | jq -e '.ok == true' >/dev/null || fail "release"
bash "$GATE" claim run-http-2 "$TIP" false | jq -e '.ok == true' >/dev/null || fail "claim"
bash "$GATE" finish "$TIP" run-http-2 GO | jq -e '.ok == true' >/dev/null || fail "finish"
bash "$GATE" ack develop_unsettled "$TIP" acked | jq -e '.ok == true' >/dev/null || fail "ack"

# 10. Nothing above reached Render: no render CLI, no api.render.com from any tool.
[ ! -s "$RENDER_LOG" ] || fail "render CLI ran: $(cat "$RENDER_LOG")"
if grep -q 'api\.render\.com' "$NET_LOG"; then fail "Render API called under http"; fi
grep -q '^curl ' "$NET_LOG" || fail "no curl recorded: the stub is not on PATH"

# 11. The detector is live: the default source does call the Render API.
: >"$NET_LOG"
SMOKE_GATE_COMMIT_SOURCE= SMOKE_GATE_BACKEND_SERVICE=srv-b SMOKE_GATE_FRONTEND_SERVICE=srv-f \
  bash "$GATE" check | jq -e '.commitSource == "render" and .settled == true' >/dev/null || fail "render source check"
grep -q 'api\.render\.com/v1/services/srv-b/deploys' "$NET_LOG" || fail "render source did not read the deploys API"

echo "smoke-develop-gate-commit-source: ok"
