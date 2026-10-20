#!/usr/bin/env bash
# Direct mode: happy path, expected host absent, stale host present, bundle
# path unextractable, and an unreachable backend behind a correct frontend.
# Relative-origin mode: a valid /api proxy, then each refusal.
# curl is stubbed via PATH so every scenario runs offline, same pattern as
# smoke-pr-gate.test.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/smoke-build-identity.sh"

STUB_BIN="$(mktemp -d)"
cleanup() { rm -rf "$STUB_BIN"; }
trap cleanup EXIT

cat > "$STUB_BIN/curl" <<'STUB'
#!/usr/bin/env bash
set -u
[ -n "${STUB_HTML+x}" ] || STUB_HTML='<html><head></head><body><script type="module" src="/assets/index-ABC123.js"></script></body></html>'
[ -n "${STUB_HTML_EXIT+x}" ] || STUB_HTML_EXIT=0
[ -n "${STUB_BUNDLE+x}" ] || STUB_BUNDLE='fetch("https://widget-api-pr-42.onrender.com/api")'
[ -n "${STUB_BUNDLE_EXIT+x}" ] || STUB_BUNDLE_EXIT=0
[ -n "${STUB_HEALTHZ_CODE+x}" ] || STUB_HEALTHZ_CODE=200
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
case "$url" in *" "*) exit 3 ;; esac
code=200; rc=0; body=""; ctype=text/html
case "$url" in
  https://api.render.com/v1/services/*/routes*) body="${STUB_ROUTES:-[]}"; code="${STUB_ROUTES_CODE:-200}"; ctype=application/json ;;
  https://api.render.com/v1/services/*) body="${STUB_SERVICE:-{\}}" ;;
  */healthz|"$STUB_BACKEND_URL/health") body="${STUB_BACKEND_HEALTH:-}"; code="$STUB_HEALTHZ_CODE" ;;
  "$STUB_FRONTEND_URL/api/health") body="${STUB_PROXY_HEALTH:-}"; code="${STUB_PROXY_CODE:-200}"; rc="${STUB_PROXY_RC:-0}" ;;
  */assets/index-ABC123.js) body="$STUB_BUNDLE"; rc="$STUB_BUNDLE_EXIT"; ctype="${STUB_BUNDLE_TYPE:-text/javascript; charset=utf-8}" ;;
  *.js|*.mjs|*.js\?*)
    f="${url##*/}"; f="$(printf '%b' "${f//%/\\x}")"
    if [ -f "${STUB_JS_DIR:-/nonexistent}/$f" ]; then body="$(cat "$STUB_JS_DIR/$f")"; ctype=application/javascript
    else body="$STUB_HTML"; fi ;;
  *) body="$STUB_HTML"; rc="$STUB_HTML_EXIT" ;;
esac
[ "$code" = 000 ] && exit 7
if [ "$fail" = true ] && [ "$code" -ge 400 ]; then exit 22; fi
if [ -n "$out" ]; then printf '%s' "$body" >"$out"; else printf '%s' "$body"; fi
case "$fmt" in *content_type*) printf '%s' "$ctype" ;; ?*) printf '%s' "$code" ;; esac
exit "$rc"
STUB
chmod +x "$STUB_BIN/curl"
export PATH="$STUB_BIN:$PATH"

reset_stubs() {
  unset STUB_HTML STUB_HTML_EXIT STUB_BUNDLE STUB_BUNDLE_EXIT STUB_HEALTHZ_CODE \
        STUB_ROUTES STUB_ROUTES_CODE STUB_SERVICE STUB_BACKEND_HEALTH STUB_PROXY_HEALTH \
        STUB_PROXY_CODE STUB_PROXY_RC STUB_BUNDLE_TYPE STUB_JS_DIR SMOKE_BUILD_ID_STALE_HOSTS SMOKE_BUILD_ID_BUNDLE_PATTERN \
        SMOKE_BUILD_ID_API_BASE SMOKE_BUILD_ID_EXPECTED_COMMIT SMOKE_BUILD_ID_FRONTEND_SERVICE \
        SMOKE_GATE_FRONTEND_SERVICE SMOKE_GATE_HEALTH_PATH RENDER_API_KEY 2>/dev/null || true
}

FRONTEND="https://widget-web-pr-42.onrender.com"
BACKEND="https://widget-api-pr-42.onrender.com"
export STUB_FRONTEND_URL="$FRONTEND" STUB_BACKEND_URL="$BACKEND"

# --- usage: missing args ----------------------------------------------------
OUT="$(bash "$SCRIPT" 2>&1 || true)"
jq -e '.ok == false and (.error | test("usage"))' <<<"$OUT" >/dev/null

# --- 1. Happy path: expected host present, no stale hosts, backend up ------
reset_stubs
export SMOKE_BUILD_ID_STALE_HOSTS='api.legacy.example'
if bash "$SCRIPT" "$FRONTEND" "$BACKEND" > "$STUB_BIN/out1.json"; then
  RC=0
else
  RC=$?
fi
[ "$RC" -eq 0 ] || { echo "expected happy path to exit 0, got $RC: $(cat "$STUB_BIN/out1.json")" >&2; exit 1; }
jq -e '
  .ok == true and
  .apiMode == "direct" and
  (has("forwardRoute") | not) and
  .expectedHost == "widget-api-pr-42.onrender.com" and
  .expectedHostCount == 1 and
  .staleHostsFound == {} and
  .backendReachable == true and
  .backendHttpCode == "200" and
  .reason == null and
  (.bundleUrl | test("assets/index-ABC123.js$"))
' "$STUB_BIN/out1.json" >/dev/null

# --- 2. Expected host absent: bundle never mentions the assigned backend ---
reset_stubs
export STUB_BUNDLE='fetch("/api/local")'
OUT="$(bash "$SCRIPT" "$FRONTEND" "$BACKEND" 2>&1)" && RC=0 || RC=$?
[ "$RC" -eq 1 ] || { echo "expected exit 1 for absent host, got $RC" >&2; exit 1; }
jq -e '.ok == false and .expectedHostCount == 0 and (.reason | test("does not appear"))' <<<"$OUT" >/dev/null

# --- 3. Stale host present: bundle references the wrong/shared-dev host ----
reset_stubs
export STUB_BUNDLE='fetch("https://widget-api-pr-42.onrender.com/api"); fetch("https://api.legacy.example/legacy")'
export SMOKE_BUILD_ID_STALE_HOSTS='api.legacy.example,another.stale.example'
OUT="$(bash "$SCRIPT" "$FRONTEND" "$BACKEND" 2>&1)" && RC=0 || RC=$?
[ "$RC" -eq 1 ] || { echo "expected exit 1 for stale host, got $RC" >&2; exit 1; }
jq -e '
  .ok == false and
  .staleHostsFound == {"api.legacy.example": 1} and
  (.reason | test("stale/wrong API host"))
' <<<"$OUT" >/dev/null

# --- 4. Bundle path unextractable: served HTML has no hashed bundle ref ----
reset_stubs
export STUB_HTML='<html><body>no module script here</body></html>'
OUT="$(bash "$SCRIPT" "$FRONTEND" "$BACKEND" 2>&1)" && RC=0 || RC=$?
[ "$RC" -eq 1 ] || { echo "expected exit 1 for unextractable bundle, got $RC" >&2; exit 1; }
jq -e '.ok == false and .bundleUrl == null and (.reason | test("could not extract"))' <<<"$OUT" >/dev/null

# --- 5. pr1142 case: frontend build identity is correct, backend is dead ---
reset_stubs
export STUB_HEALTHZ_CODE=503
OUT="$(bash "$SCRIPT" "$FRONTEND" "$BACKEND" 2>&1)" && RC=0 || RC=$?
[ "$RC" -eq 1 ] || { echo "expected exit 1 for unreachable backend, got $RC" >&2; exit 1; }
jq -e '
  .ok == false and
  .expectedHostCount == 1 and
  .staleHostsFound == {} and
  .backendReachable == false and
  (.reason | test("backend is not reachable"))
' <<<"$OUT" >/dev/null

# --- Relative-origin mode: clients compile to /api behind a static rewrite --
SHA_OK="1111111111111111111111111111111111111111"
SHA_OTHER="2222222222222222222222222222222222222222"
JS_FIX="$STUB_BIN/js"
mkdir -p "$JS_FIX"
ENTRY_REL='const pub="/api";const lazy=()=>import("./desk-D3sk.js");'
CHUNK_REL='const desk="/api";fetch(desk+"/desk/me")'
ROUTES_OK='[{"route":{"id":"rdr-1","type":"rewrite","source":"/api/*","destination":"https://widget-api-pr-42.onrender.com/*","priority":0},"cursor":"a"},
            {"route":{"id":"rdr-2","type":"rewrite","source":"/*","destination":"/index.html","priority":1},"cursor":"b"}]'

relative_stubs() {
  reset_stubs
  export SMOKE_BUILD_ID_API_BASE=/api SMOKE_BUILD_ID_EXPECTED_COMMIT="$SHA_OK" \
         SMOKE_BUILD_ID_FRONTEND_SERVICE=srv-widgetweb42 SMOKE_GATE_HEALTH_PATH=/health \
         RENDER_API_KEY=stub-key SMOKE_BUILD_ID_STALE_HOSTS='api.legacy.example'
  export STUB_JS_DIR="$JS_FIX" STUB_BUNDLE="$ENTRY_REL" STUB_ROUTES="$ROUTES_OK"
  export STUB_SERVICE='{"id":"srv-widgetweb42","type":"static_site","serviceDetails":{"url":"https://widget-web-pr-42.onrender.com"}}'
  export STUB_BACKEND_HEALTH="{\"ok\":true,\"commit\":\"$SHA_OK\"}"
  export STUB_PROXY_HEALTH="{\"ok\":true,\"commit\":\"$SHA_OK\"}"
  printf '%s' "$CHUNK_REL" >"$JS_FIX/desk-D3sk.js"
}

expect_refusal() {  # <case label> <reason regex>
  local out rc
  out="$(bash "$SCRIPT" "$FRONTEND" "$BACKEND" 2>&1)" && rc=0 || rc=$?
  [ "$rc" -eq 1 ] || { echo "$1: expected exit 1, got $rc: $out" >&2; exit 1; }
  jq -e --arg re "$2" '.ok == false and .apiMode == "relative" and (.reason | test($re))' <<<"$out" >/dev/null ||
    { echo "$1: reason did not match /$2/: $out" >&2; exit 1; }
}

# R1. Valid /api proxy: both clients relative, rewrite binds the frozen backend.
relative_stubs
OUT="$(bash "$SCRIPT" "$FRONTEND" "$BACKEND" 2>&1)" && RC=0 || RC=$?
[ "$RC" -eq 0 ] || { echo "R1: expected valid /api proxy to pass, got $RC: $OUT" >&2; exit 1; }
jq -e --arg sha "$SHA_OK" '
  .ok == true and .apiMode == "relative" and .apiBase == "/api" and
  .scannedFiles == 2 and .apiBaseRefs == 2 and .expectedHostCount == 0 and
  .staleHostsFound == {} and .backendCommit == $sha and .sameOriginCommit == $sha and
  .forwardRoute.destination == "https://widget-api-pr-42.onrender.com/*" and
  .sameOriginUrl == "https://widget-web-pr-42.onrender.com/api/health" and .reason == null
' <<<"$OUT" >/dev/null || { echo "R1: unexpected output: $OUT" >&2; exit 1; }

# R2. Rewrite forwards to a different backend.
relative_stubs
export STUB_ROUTES='[{"route":{"id":"rdr-1","type":"rewrite","source":"/api/*","destination":"https://widget-api-other.onrender.com/*","priority":0},"cursor":"a"}]'
expect_refusal R2 'wrong forwarding target'

# R3. No /api rewrite at all: only the SPA catchall answers.
relative_stubs
export STUB_ROUTES='[{"route":{"id":"rdr-2","type":"rewrite","source":"/*","destination":"/index.html","priority":0},"cursor":"b"}]'
export STUB_PROXY_HEALTH='<!doctype html><html><body>app</body></html>'
expect_refusal R3 'missing rewrite'

# R4. The catchall outranks the /api rewrite, so it wins every /api request.
relative_stubs
export STUB_ROUTES='[{"route":{"id":"rdr-1","type":"rewrite","source":"/api/*","destination":"https://widget-api-pr-42.onrender.com/*","priority":1},"cursor":"a"},
                     {"route":{"id":"rdr-2","type":"rewrite","source":"/*","destination":"/index.html","priority":0},"cursor":"b"}]'
expect_refusal R4 'is rewrite /\* -> /index.html.*missing rewrite'

# R5. Routes read correctly but the same-origin probe gets SPA HTML with a 200.
relative_stubs
export STUB_PROXY_HEALTH='<!doctype html><html><body>app</body></html>'
expect_refusal R5 'same-origin health .*not exactly one JSON object'

# R6. Same-origin health JSON carries no commit.
relative_stubs
export STUB_PROXY_HEALTH='{"ok":true}'
expect_refusal R6 'same-origin health .*no 40-hex'

# R7. Same-origin health serves a different commit than the frozen one.
relative_stubs
export STUB_PROXY_HEALTH="{\"ok\":true,\"commit\":\"$SHA_OTHER\"}"
expect_refusal R7 "same-origin health .*serves commit $SHA_OTHER"

# R8. Direct backend health serves the wrong commit.
relative_stubs
export STUB_BACKEND_HEALTH="{\"ok\":true,\"sha\":\"$SHA_OTHER\"}"
expect_refusal R8 "backend .*serves commit $SHA_OTHER"

# R9. Backend unreachable.
relative_stubs
export STUB_HEALTHZ_CODE=000
expect_refusal R9 'backend is not reachable'

# R10. A lazily loaded chunk still names a stale host.
relative_stubs
printf '%s' 'const desk="/api";const old="https://api.legacy.example"' >"$JS_FIX/desk-D3sk.js"
expect_refusal R10 'stale/wrong API host'

# R11. Split clients: one chunk calls the backend origin directly.
relative_stubs
printf '%s' 'const desk="https://widget-api-pr-42.onrender.com"' >"$JS_FIX/desk-D3sk.js"
expect_refusal R11 'split between the proxy and a direct origin'

# R12. A referenced chunk is missing and the catchall serves HTML for it.
relative_stubs
rm -f "$JS_FIX/desk-D3sk.js"
expect_refusal R12 'desk-D3sk.js.*partial'

# R13. No client compiles to the configured base.
relative_stubs
export STUB_BUNDLE='const pub="/v2";'
expect_refusal R13 'no scanned bundle quotes the relative API base'

# R14. The service id names a different static site (e.g. a shared develop pair).
relative_stubs
export STUB_SERVICE='{"id":"srv-widgetweb42","type":"static_site","serviceDetails":{"url":"https://widget-web-develop.onrender.com"}}'
expect_refusal R14 'is not the static site serving'

# R15. Health reports ok:false.
relative_stubs
export STUB_PROXY_HEALTH="{\"ok\":false,\"commit\":\"$SHA_OK\"}"
expect_refusal R15 'reports ok other than true'

# R17. A route ahead of the correct rewrite diverts part of the API namespace.
relative_stubs
export STUB_ROUTES='[{"route":{"id":"rdr-0","type":"rewrite","source":"/api/users/*","destination":"https://widget-api-other.onrender.com/users/*","priority":0},"cursor":"z"},
                     {"route":{"id":"rdr-1","type":"rewrite","source":"/api/*","destination":"https://widget-api-pr-42.onrender.com/*","priority":1},"cursor":"a"},
                     {"route":{"id":"rdr-2","type":"rewrite","source":"/*","destination":"/index.html","priority":2},"cursor":"b"}]'
expect_refusal R17 '/api/users/\* .*overlaps it'

# R18. A route ahead of the rewrite outside the API namespace does not matter.
relative_stubs
export STUB_ROUTES='[{"route":{"id":"rdr-0","type":"redirect","source":"/old-home","destination":"/","priority":0},"cursor":"z"},
                     {"route":{"id":"rdr-1","type":"rewrite","source":"/api/*","destination":"https://widget-api-pr-42.onrender.com/*","priority":1},"cursor":"a"},
                     {"route":{"id":"rdr-2","type":"rewrite","source":"/*","destination":"/index.html","priority":2},"cursor":"b"}]'
OUT="$(bash "$SCRIPT" "$FRONTEND" "$BACKEND" 2>&1)" && RC=0 || RC=$?
[ "$RC" -eq 0 ] || { echo "R18: expected an unrelated earlier route to pass, got $RC: $OUT" >&2; exit 1; }

# R19. A placeholder route ahead of the rewrite can match paths under /api.
relative_stubs
export STUB_ROUTES='[{"route":{"id":"rdr-0","type":"rewrite","source":"/:tenant/users/*","destination":"https://widget-api-other.onrender.com/:tenant/*","priority":0},"cursor":"z"},
                     {"route":{"id":"rdr-1","type":"rewrite","source":"/api/*","destination":"https://widget-api-pr-42.onrender.com/*","priority":1},"cursor":"a"}]'
expect_refusal R19 '/:tenant/users/\* .*overlaps it'

# R20. A placeholder route that matches the health path itself wins it.
relative_stubs
export STUB_ROUTES='[{"route":{"id":"rdr-0","type":"rewrite","source":"/:area/health","destination":"/index.html","priority":0},"cursor":"z"},
                     {"route":{"id":"rdr-1","type":"rewrite","source":"/api/*","destination":"https://widget-api-pr-42.onrender.com/*","priority":1},"cursor":"a"}]'
expect_refusal R20 'is rewrite /:area/health -> /index.html.*missing rewrite'

# R21. A chunk referenced with a query suffix is fetched with that query, and
#      the response at that exact URL is what gets scanned and required.
relative_stubs
export STUB_BUNDLE='const pub="/api";const lazy=()=>import("./desk-D3sk.js?v=42");'
printf '%s' 'const desk="/api";const old="https://api.legacy.example"' >"$JS_FIX/desk-D3sk.js?v=42"
expect_refusal R21a 'stale/wrong API host'
printf '%s' 'const desk="https://widget-api-pr-42.onrender.com"' >"$JS_FIX/desk-D3sk.js?v=42"
expect_refusal R21b 'split between the proxy and a direct origin'
rm -f "$JS_FIX/desk-D3sk.js?v=42"
expect_refusal R21c 'desk-D3sk.js\?v=42.*partial'

# R26. A dot-prefixed chunk name is scanned like any other.
relative_stubs
export STUB_BUNDLE='const pub="/api";const lazy=()=>import("./.client-H4sh.js");'
printf '%s' 'const c="/api";const old="https://api.legacy.example"' >"$JS_FIX/.client-H4sh.js"
expect_refusal R26a 'stale/wrong API host'
printf '%s' 'const c="https://widget-api-pr-42.onrender.com"' >"$JS_FIX/.client-H4sh.js"
expect_refusal R26b 'split between the proxy and a direct origin'
rm -f "$JS_FIX/.client-H4sh.js"
expect_refusal R26c '\.client-H4sh\.js.*partial'

# R22. The entry bundle path answers with the SPA page, which quotes the base;
#      a long leading comment hides the doctype from any sniff of the body.
relative_stubs
export STUB_BUNDLE_TYPE='text/html; charset=utf-8'
export STUB_BUNDLE="<!-- $(printf 'x%.0s' $(seq 1 600)) --><!DOCTYPE
html><script>window.API_BASE=\"/api\"</script>"
expect_refusal R22 'entry bundle .*served as text/html.*not JavaScript'

# R25. An .mjs chunk is scanned and required like a .js one.
relative_stubs
export STUB_BUNDLE='const pub="/api";const lazy=()=>import("./desk-D3sk.mjs");'
printf '%s' 'const desk="/api";const old="https://api.legacy.example"' >"$JS_FIX/desk-D3sk.mjs"
expect_refusal R25a 'stale/wrong API host'
printf '%s' 'const desk="https://widget-api-pr-42.onrender.com"' >"$JS_FIX/desk-D3sk.mjs"
expect_refusal R25b 'split between the proxy and a direct origin'
rm -f "$JS_FIX/desk-D3sk.mjs"
expect_refusal R25c 'desk-D3sk.mjs.*partial'

# R23. Same-origin health is 200 with the right JSON but the transfer failed.
relative_stubs
export STUB_PROXY_RC=18
expect_refusal R23 'same-origin health .*transfer failed \(curl exit 18\)'

# R24. Two JSON documents where one is expected.
relative_stubs
export STUB_PROXY_HEALTH="{\"ok\":false}{\"commit\":\"$SHA_OK\"}"
expect_refusal R24 'same-origin health .*not exactly one JSON object'

# R27. A chunk name outside ASCII is scanned and required like any other.
relative_stubs
export STUB_BUNDLE='const pub="/api";const lazy=()=>import("./résumé-BaUe4dnc.js");'
printf '%s' 'const r="/api";const old="https://api.legacy.example"' >"$JS_FIX/résumé-BaUe4dnc.js"
expect_refusal R27a 'stale/wrong API host'
printf '%s' 'const r="https://widget-api-pr-42.onrender.com"' >"$JS_FIX/résumé-BaUe4dnc.js"
expect_refusal R27b 'split between the proxy and a direct origin'
rm -f "$JS_FIX/résumé-BaUe4dnc.js"
expect_refusal R27c 'résumé-BaUe4dnc.js.*partial'

# R28. A CommonJS module id embedded in the bundle is not a chunk to fetch,
#      while a static import between chunks is followed.
relative_stubs
export STUB_BUNDLE='var i=m(n("./v1.js"));var t={"./v4.js":539};const pub="/api";import{a}from"./shared-S1.js";'
printf '%s' 'export const a="/api";' >"$JS_FIX/shared-S1.js"
OUT="$(bash "$SCRIPT" "$FRONTEND" "$BACKEND" 2>&1)" && RC=0 || RC=$?
[ "$RC" -eq 0 ] || { echo "R28: an embedded module id was fetched as a chunk, got $RC: $OUT" >&2; exit 1; }
jq -e '.scannedFiles == 2' <<<"$OUT" >/dev/null || { echo "R28: the static import was not followed: $OUT" >&2; exit 1; }
printf '%s' 'export const a="https://api.legacy.example";' >"$JS_FIX/shared-S1.js"
expect_refusal R28b 'stale/wrong API host'
rm -f "$JS_FIX/shared-S1.js"

# R29. A worker emitted under a relative base, new URL("w.js", import.meta.url).
relative_stubs
export STUB_BUNDLE='const pub="/api";const w=new Worker(new URL("worker-C7z.js",import.meta.url).href,{type:"module"});'
printf '%s' 'const w="/api";const old="https://api.legacy.example"' >"$JS_FIX/worker-C7z.js"
expect_refusal R29a 'stale/wrong API host'
printf '%s' 'const w="https://widget-api-pr-42.onrender.com"' >"$JS_FIX/worker-C7z.js"
expect_refusal R29b 'split between the proxy and a direct origin'
rm -f "$JS_FIX/worker-C7z.js"
expect_refusal R29c 'worker-C7z.js.*partial'

# R30. A chunk name with a space is requested percent-encoded and scanned.
relative_stubs
export STUB_BUNDLE='const pub="/api";const lazy=()=>import(`./desk space-D0Pu.js`);'
printf '%s' 'const d="/api";const old="https://api.legacy.example"' >"$JS_FIX/desk space-D0Pu.js"
expect_refusal R30a 'stale/wrong API host'
printf '%s' 'const d="https://widget-api-pr-42.onrender.com"' >"$JS_FIX/desk space-D0Pu.js"
expect_refusal R30b 'split between the proxy and a direct origin'
rm -f "$JS_FIX/desk space-D0Pu.js"
expect_refusal R30c 'desk space-D0Pu.js.*partial'

# R16. Relative mode without a frozen commit is a usage error.
relative_stubs
unset SMOKE_BUILD_ID_EXPECTED_COMMIT
OUT="$(bash "$SCRIPT" "$FRONTEND" "$BACKEND" 2>&1)" && RC=0 || RC=$?
[ "$RC" -eq 2 ] || { echo "R16: expected exit 2, got $RC: $OUT" >&2; exit 1; }
jq -e '.ok == false and (.error | test("EXPECTED_COMMIT"))' <<<"$OUT" >/dev/null

echo "smoke build identity tests passed"
