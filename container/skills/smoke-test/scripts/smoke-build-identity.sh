#!/usr/bin/env bash
# Deterministic build-identity preflight: proves a deployed frontend build was
# actually compiled against the expected backend host, and that the backend
# is reachable — before any browser lane is allowed to start.
#
# Until now this was hand-driven browser work every campaign repeated: fetch
# the frontend HTML, find the hashed JS bundle, grep it for the expected
# backend host and for a known-wrong one (see the B5 lane of
# a run whose lane evidence records it for the technique this codifies). Burned
# as LLM browser time on every run, and its failure mode is worse than slow:
# on one 2026-08-23 run the coordinator's three
# browser lanes all ran against a preview host with NO SERVER BOUND TO IT —
# "All three of my browser lanes produced zero coverage" — and the evidence
# had to be discarded. A frontend that serves fine while its API host
# resolves to nothing looks identical to a correct build until something
# actually calls the backend, so this script makes that call explicit and
# gates on it.
#
# Usage: smoke-build-identity.sh <frontend-base-url> <backend-base-url>
#
# Config (env, deployment-specific — never hardcode a tenant host here):
#   SMOKE_BUILD_ID_STALE_HOSTS    comma-separated wrong/stale API hosts the
#                                 bundle must NOT reference. Unset = skip that
#                                 check (weaker; the expected-host and
#                                 backend-reachable checks still run).
#   SMOKE_BUILD_ID_BUNDLE_PATTERN extended-regex bundle-reference shape to
#                                 grep the served HTML for. Default matches
#                                 the Vite/Rollup hashed entry every sampled
#                                 run has actually used.
#   SMOKE_BUILD_ID_TIMEOUT       per-fetch curl --max-time, default 10s.
#   SMOKE_GATE_HEALTH_PATH       backend readiness path, default /healthz.
#
# Relative-origin mode (SMOKE_BUILD_ID_API_BASE set, e.g. /api): the clients
# call a same-origin path that the static site rewrites to the backend, so the
# backend host is legitimately absent from the bundle and each of these must
# bind to the frozen backend instead, failing closed:
#   - the entry bundle and every chunk it reaches (same directory, followed
#     transitively, each served with a JavaScript content type) quote the base, and none names the backend host directly
#     (clients split between proxy and direct origin) or a stale host;
#   - the static site's first route matching <base><health path>, in Render
#     priority order, is the rewrite <base>/* -> <backend-base-url>/*, and no
#     other route at or ahead of its priority can match a path under <base>
#     (Render `*` wildcards and `:name` placeholders both count). Render serves
#     a published file before any rule and has no API that lists those files,
#     so a stale file shipped under <base> is outside what this proves;
#   - <backend><health path> and <frontend><base><health path> both answer 200
#     over a completed transfer with exactly one JSON object whose
#     sha/commit/gitSha is the frozen commit and whose `ok`, when present, is
#     true.
#   SMOKE_BUILD_ID_API_BASE          the clients' compiled API base path.
#   SMOKE_BUILD_ID_EXPECTED_COMMIT   frozen backend commit, 40 hex (required).
#   SMOKE_BUILD_ID_FRONTEND_SERVICE  the static site's Render service id, else
#                                    SMOKE_GATE_FRONTEND_SERVICE; its served
#                                    URL must equal <frontend-base-url>.
#   RENDER_API_KEY                   reads that service and its routes.
#   SMOKE_BUILD_ID_MAX_CHUNKS        JS files scanned before refusing, default 200.
#
# SMOKE_GATE_COMMIT_SOURCE=http (default render; the develop gate's knob):
# nothing reads Render. Both health probes above become commit-bound in either
# mode, and the forwarding proof in relative mode is the response itself
# rather than the static site's route table:
#   - <backend><health path> and, in relative mode,
#     <frontend><base><health path> each answer 200 with one JSON object whose
#     top-level `commit` is the frozen commit (smoke-served-commit.sh: 7-40
#     hex, an abbreviation kept only when it prefixes it or resolves through
#     GitHub via SMOKE_GATE_REPO), read with a cache-busting parameter;
#   - each body satisfies SMOKE_BUILD_ID_BACKEND_MARKER, a jq predicate that
#     must print exactly one `true` (jq's exit status alone is not the answer:
#     a predicate that reaches `halt` exits 0 having printed nothing). Another environment can run the same
#     commit (production deploying the same main), so the commit alone does
#     not prove the intended backend answered; the marker must name something
#     only that backend reports.
#   What http gives up in relative mode: only <base><health path> is shown to
#   reach the marked backend, not that every path under <base> does (a
#   narrower route ahead of the rewrite is invisible), and the frontend URL
#   is not tied to a Render service id.
#   SMOKE_BUILD_ID_EXPECTED_COMMIT and SMOKE_BUILD_ID_BACKEND_MARKER are
#   required, both base URLs must be https, and the Render service id and
#   RENDER_API_KEY are not read.
#
# One JSON line on stdout, same convention as the sibling gate scripts.
# Exit 0 on ok:true, 1 on a failed check (a caller gates a campaign start on
# this), 2 on a usage error.
set -u

die() { jq -cn --arg e "$1" '{ok:false,error:$e}'; exit 2; }

FRONTEND_URL="${1:-}"
BACKEND_URL="${2:-}"
[ -n "$FRONTEND_URL" ] && [ -n "$BACKEND_URL" ] ||
  die "usage: smoke-build-identity.sh <frontend-base-url> <backend-base-url>"
printf '%s' "$FRONTEND_URL" | grep -Eq '^https?://' ||
  die "frontend base url must start with http:// or https://"
printf '%s' "$BACKEND_URL" | grep -Eq '^https?://' ||
  die "backend base url must start with http:// or https://"

TIMEOUT="${SMOKE_BUILD_ID_TIMEOUT:-10}"
STALE_HOSTS_RAW="${SMOKE_BUILD_ID_STALE_HOSTS:-}"
BUNDLE_PATTERN="${SMOKE_BUILD_ID_BUNDLE_PATTERN:-assets/index-[A-Za-z0-9_]+\.js}"
HEALTH_PATH="${SMOKE_GATE_HEALTH_PATH:-/healthz}"
API_BASE="${SMOKE_BUILD_ID_API_BASE:-}"
EXPECTED_COMMIT="${SMOKE_BUILD_ID_EXPECTED_COMMIT:-}"
FRONTEND_SERVICE="${SMOKE_BUILD_ID_FRONTEND_SERVICE:-${SMOKE_GATE_FRONTEND_SERVICE:-}}"
MAX_CHUNKS="${SMOKE_BUILD_ID_MAX_CHUNKS:-200}"
COMMIT_SOURCE="${SMOKE_GATE_COMMIT_SOURCE:-render}"
BACKEND_MARKER="${SMOKE_BUILD_ID_BACKEND_MARKER:-}"
REPO="${SMOKE_GATE_REPO:-}"
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/smoke-preview-static.sh"
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/smoke-served-commit.sh"

case "$COMMIT_SOURCE" in render|http) ;; *)
  die "SMOKE_GATE_COMMIT_SOURCE must be render or http" ;; esac
if [ "$COMMIT_SOURCE" = http ]; then
  commit_url_valid "$FRONTEND_URL" && commit_url_valid "$BACKEND_URL" &&
    [[ "$FRONTEND_URL$BACKEND_URL" != *\?* ]] ||
    die "SMOKE_GATE_COMMIT_SOURCE=http needs https base urls with no whitespace, query or # fragment"
  printf '%s' "$HEALTH_PATH" | grep -Eq '^(/[A-Za-z0-9._~-]+)+$' ||
    die "SMOKE_GATE_COMMIT_SOURCE=http needs SMOKE_GATE_HEALTH_PATH to be a plain path such as /health, so the cache buster reaches the server"
  printf '%s' "$EXPECTED_COMMIT" | grep -Eq '^[0-9a-f]{40}$' ||
    die "SMOKE_GATE_COMMIT_SOURCE=http needs SMOKE_BUILD_ID_EXPECTED_COMMIT, the frozen backend's 40-hex commit"
  [ -n "$BACKEND_MARKER" ] && jq -n "def marker: ($BACKEND_MARKER); 0" >/dev/null 2>&1 ||
    die "SMOKE_GATE_COMMIT_SOURCE=http needs SMOKE_BUILD_ID_BACKEND_MARKER, a jq predicate only the intended backend's health body satisfies"
  FRONTEND_SERVICE=""
fi

API_MODE=direct
if [ -n "$API_BASE" ]; then
  API_MODE=relative
  printf '%s' "$API_BASE" | grep -Eq '^(/[A-Za-z0-9._~-]+)+$' ||
    die "SMOKE_BUILD_ID_API_BASE must be an absolute path such as /api"
  printf '%s' "$EXPECTED_COMMIT" | grep -Eq '^[0-9a-f]{40}$' ||
    die "SMOKE_BUILD_ID_API_BASE needs SMOKE_BUILD_ID_EXPECTED_COMMIT, the frozen backend's 40-hex commit"
  if [ "$COMMIT_SOURCE" = render ]; then
    printf '%s' "$FRONTEND_SERVICE" | grep -Eq '^srv-[a-z0-9]+$' ||
      die "SMOKE_BUILD_ID_API_BASE needs SMOKE_BUILD_ID_FRONTEND_SERVICE (or SMOKE_GATE_FRONTEND_SERVICE), the static site's Render service id"
    [ -n "${RENDER_API_KEY:-}" ] ||
      die "SMOKE_BUILD_ID_API_BASE needs RENDER_API_KEY to read the static site's rewrite routes"
  fi
  printf '%s' "$MAX_CHUNKS" | grep -Eq '^[1-9][0-9]*$' ||
    die "SMOKE_BUILD_ID_MAX_CHUNKS must be a positive integer"
fi

FRONTEND_URL="${FRONTEND_URL%/}"
BACKEND_URL="${BACKEND_URL%/}"
EXPECTED_HOST="$(printf '%s' "$BACKEND_URL" | sed -E 's#^https?://##; s#/.*$##')"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
HTML_FILE="$TMP_DIR/index.html"
BUNDLE_FILE="$TMP_DIR/bundle.js"
JS_DIR="$TMP_DIR/js"
mkdir -p "$JS_DIR"

HTML_FETCH_OK=false
if curl -fsS --max-time "$TIMEOUT" "$FRONTEND_URL/" >"$HTML_FILE" 2>/dev/null; then
  HTML_FETCH_OK=true
fi

BUNDLE_PATH=""
if [ "$HTML_FETCH_OK" = true ]; then
  BUNDLE_PATH="$(grep -oE "$BUNDLE_PATTERN" "$HTML_FILE" | head -1)"
fi

BUNDLE_URL=""
BUNDLE_TYPE=""
BUNDLE_FETCH_OK=false
if [ -n "$BUNDLE_PATH" ]; then
  BUNDLE_URL="$FRONTEND_URL/$BUNDLE_PATH"
  if BUNDLE_TYPE="$(curl -fsS -o "$BUNDLE_FILE" -w '%{content_type}' --max-time "$TIMEOUT" "$BUNDLE_URL" 2>/dev/null)"; then
    BUNDLE_FETCH_OK=true
  fi
fi

fixed_re() { printf '%s' "$1" | sed 's/[][\.*^$+?(){}|]/\\&/g'; }
count_in_scan() { cat "$JS_DIR"/* | grep -oE -- "$1" | wc -l | tr -d ' '; }

is_js_type() { printf '%s' "$1" | grep -qiE '^(application|text)/(x-)?(javascript|ecmascript)([;[:space:]]|$)'; }

SCAN_ERROR=""
SCANNED_FILES=0
# A relative "./x.js" counts only as an import specifier or a
# new URL(..., import.meta.url) worker: bundles also embed prebuilt CommonJS
# libraries whose module ids look the same (n("./v1.js")) and name no served
# file. A directory-qualified "assets/x.js" is always a chunk.
chunk_refs() {  # <js file> <directory ERE> → each same-directory module it loads, as name[?query]
  local name="[^\"'\`/?#]+\.[mc]?js([?#][^\"'\`]*)?[\"'\`]"
  {
    LC_ALL=C grep -oE "(import|from)[[:space:]]*\(?[[:space:]]*[\"'\`]\./$name" "$1"
    LC_ALL=C grep -oE "[\"'\`]$2$name" "$1"
    LC_ALL=C grep -oE "URL\([[:space:]]*[\"'\`](\./)?$name[[:space:]]*,[[:space:]]*import\.meta\.url" "$1" |
      LC_ALL=C grep -oE "[\"'\`](\./)?$name"
  } | sed -E "s/#[^\"'\`]*//; s/.\$//; s#^[^?]*/##; s/^[\"'\`]//"
}

chunk_url_path() {  # name[?query] → percent-encoded for the request line
  jq -rn --arg r "$1" '($r | split("?")) as $p | ($p[0] | @uri)
    + (if ($p | length) > 1 then "?" + ($p[1:] | join("?") | gsub(" "; "%20")) else "" end)'
}

scan_relative_bundles() {
  local dir dir_re ref type i=1 queue="$TMP_DIR/queue"
  dir="$(dirname "$BUNDLE_PATH")"
  if [ "$dir" = . ]; then dir=""; dir_re=/; else dir_re="/?$(fixed_re "$dir")/"; fi
  if ! is_js_type "$BUNDLE_TYPE"; then
    SCAN_ERROR="entry bundle $BUNDLE_PATH was served as ${BUNDLE_TYPE:-no content type}, not JavaScript"
    return
  fi
  cp "$BUNDLE_FILE" "$JS_DIR/1"
  basename "$BUNDLE_PATH" >"$queue"
  while ref="$(sed -n "${i}p" "$queue")" && [ -n "$ref" ]; do
    if [ ! -f "$JS_DIR/$i" ]; then
      if ! type="$(curl -fsSg -o "$JS_DIR/$i" -w '%{content_type}' --max-time "$TIMEOUT" \
        "$FRONTEND_URL/${dir:+$dir/}$(chunk_url_path "$ref")" 2>/dev/null)" || ! is_js_type "$type"; then
        SCAN_ERROR="chunk ${dir:+$dir/}$ref, referenced by the bundle, could not be fetched as JavaScript — the scan would be partial"
        return
      fi
    fi
    chunk_refs "$JS_DIR/$i" "$dir_re" |
      while read -r ref; do
        grep -qxF -- "$ref" "$queue" || printf '%s\n' "$ref" >>"$queue"
      done
    if [ "$(wc -l <"$queue")" -gt "$MAX_CHUNKS" ]; then
      SCAN_ERROR="the bundle reaches more than $MAX_CHUNKS JS files (SMOKE_BUILD_ID_MAX_CHUNKS) — the scan would be partial"
      return
    fi
    i=$((i + 1))
  done
  SCANNED_FILES=$((i - 1))
}

EXPECTED_HOST_COUNT=0
API_BASE_REFS=0
STALE_FOUND='{}'
if [ "$BUNDLE_FETCH_OK" = true ]; then
  if [ "$API_MODE" = direct ]; then
    EXPECTED_HOST_COUNT="$(grep -cF -- "$EXPECTED_HOST" "$BUNDLE_FILE" || true)"
  else
    scan_relative_bundles
    if [ -z "$SCAN_ERROR" ]; then
      EXPECTED_HOST_COUNT="$(count_in_scan "$(fixed_re "$EXPECTED_HOST")")"
      API_BASE_REFS="$(count_in_scan "[\"'\`]$(fixed_re "$API_BASE")([\"'\`]|/)")"
    fi
  fi
  if [ -n "$STALE_HOSTS_RAW" ] && [ -z "$SCAN_ERROR" ]; then
    IFS=',' read -ra STALE_HOSTS <<<"$STALE_HOSTS_RAW"
    for h in "${STALE_HOSTS[@]}"; do
      h="$(printf '%s' "$h" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
      [ -n "$h" ] || continue
      if [ "$API_MODE" = direct ]; then
        c="$(grep -cF -- "$h" "$BUNDLE_FILE" || true)"
      else
        c="$(count_in_scan "$(fixed_re "$h")")"
      fi
      if [ "$c" -gt 0 ]; then
        STALE_FOUND="$(jq -c --arg h "$h" --argjson c "$c" '. + {($h): $c}' <<<"$STALE_FOUND")"
      fi
    done
  fi
fi

probe_health() {  # <url> → PROBE_CODE, PROBE_COMMIT, PROBE_PROBLEM
  local body="$TMP_DIR/probe.json"
  : >"$body"
  PROBE_COMMIT=""
  PROBE_PROBLEM=""
  local rc=0 url="$1"
  [ "$COMMIT_SOURCE" = render ] || url="$(commit_url_nocache "$1")"
  PROBE_CODE="$(curl -sS -o "$body" -w '%{http_code}' --max-time "$TIMEOUT" "$url" 2>/dev/null)" || rc=$?
  if [ "$PROBE_CODE" != 200 ]; then
    PROBE_PROBLEM="returned ${PROBE_CODE:-no response}, not 200"
  elif [ "$rc" -ne 0 ]; then
    PROBE_PROBLEM="returned 200 but the transfer failed (curl exit $rc)"
  elif ! jq -se 'length == 1 and (.[0] | type == "object")' "$body" >/dev/null 2>&1; then
    PROBE_PROBLEM="returned 200 but not exactly one JSON object (an SPA page served in place of health)"
  elif jq -e 'has("ok") and .ok != true' "$body" >/dev/null 2>&1; then
    PROBE_PROBLEM="reports ok other than true"
  elif [ "$COMMIT_SOURCE" = http ]; then
    PROBE_COMMIT="$(served_commit_sha "$body" "$EXPECTED_COMMIT" "$REPO")"
    if [ -z "$PROBE_COMMIT" ]; then
      PROBE_PROBLEM="carries no top-level commit that is 7-40 hex and resolves to a full SHA"
    elif [ "$PROBE_COMMIT" != "$EXPECTED_COMMIT" ]; then
      PROBE_PROBLEM="serves commit $PROBE_COMMIT, not the frozen $EXPECTED_COMMIT"
    elif [ "$(jq -r "[($BACKEND_MARKER)] == [true]" "$body" 2>/dev/null)" != true ]; then
      PROBE_PROBLEM="serves the frozen commit but does not satisfy SMOKE_BUILD_ID_BACKEND_MARKER ($BACKEND_MARKER) — another environment on the same commit answered"
    fi
  else
    PROBE_COMMIT="$(jq -r "$SERVED_SHA_JQ" "$body" 2>/dev/null)"
    if [ -z "$PROBE_COMMIT" ]; then
      PROBE_PROBLEM="carries no 40-hex sha/commit/gitSha"
    elif [ "$PROBE_COMMIT" != "$EXPECTED_COMMIT" ]; then
      PROBE_PROBLEM="serves commit $PROBE_COMMIT, not the frozen $EXPECTED_COMMIT"
    fi
  fi
}

# Verify the backend is actually reachable and bound — the pr1142 failure. A
# frontend that serves fine while its API host resolves to nothing must fail
# here, loudly, independent of whether the bundle checks above passed.
BACKEND_REACHABLE=false
BACKEND_HTTP_CODE=""
BACKEND_COMMIT=""
BACKEND_PROBLEM=""
if [ "$API_MODE" = direct ] && [ "$COMMIT_SOURCE" = render ]; then
  CODE="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "${BACKEND_URL}${HEALTH_PATH}" 2>/dev/null)"
  if [ $? -eq 0 ] && [ "$CODE" = "200" ]; then
    BACKEND_REACHABLE=true
    BACKEND_HTTP_CODE="$CODE"
  elif [ -n "$CODE" ]; then
    BACKEND_HTTP_CODE="$CODE"
  fi
else
  probe_health "${BACKEND_URL}${HEALTH_PATH}"
  BACKEND_HTTP_CODE="$PROBE_CODE"
  BACKEND_COMMIT="$PROBE_COMMIT"
  BACKEND_PROBLEM="$PROBE_PROBLEM"
  [ "$PROBE_CODE" = 200 ] && BACKEND_REACHABLE=true
fi

FORWARD_ROUTE=null
FORWARD_PROBLEM=""
SAME_ORIGIN_URL=""
SAME_ORIGIN_HTTP_CODE=""
SAME_ORIGIN_COMMIT=""
SAME_ORIGIN_PROBLEM=""
PROBE_PATH="$API_BASE$HEALTH_PATH"
if [ "$API_MODE" = relative ] && [ "$COMMIT_SOURCE" = render ]; then
  SVC_API="https://api.render.com/v1/services/$FRONTEND_SERVICE"
  if ! SERVICE_JSON="$(curl -fsS --max-time "$TIMEOUT" -H "Authorization: Bearer $RENDER_API_KEY" "$SVC_API" 2>/dev/null)"; then
    FORWARD_PROBLEM="could not read Render service $FRONTEND_SERVICE"
  elif ! jq -e --arg u "$FRONTEND_URL" '.type == "static_site" and ((.serviceDetails.url // "") | rtrimstr("/")) == $u' <<<"$SERVICE_JSON" >/dev/null 2>&1; then
    FORWARD_PROBLEM="Render service $FRONTEND_SERVICE is not the static site serving $FRONTEND_URL"
  elif ! ROUTES_JSON="$(curl -fsS --max-time "$TIMEOUT" -H "Authorization: Bearer $RENDER_API_KEY" "$SVC_API/routes?limit=100" 2>/dev/null)"; then
    FORWARD_PROBLEM="could not read the routes of Render service $FRONTEND_SERVICE"
  else
    ROUTE_EVAL="$(jq -c --arg probe "$PROBE_PATH" --arg base "$API_BASE" '
      def glob: gsub("(?<c>[.+?^${}()|\\[\\]\\\\])"; "\\\(.c)") | gsub("/:[^/]+"; "/[^/]+")
        | gsub("\\*"; ".*") | "^" + . + "$";
      def wild: [index("*"), (index("/:") | if . == null then null else . + 1 end)] | map(select(. != null)) | min;
      def under_base: wild as $i
        | if $i == null then . == $base or startswith($base + "/")
          else .[0:$i] as $p | ($base + "/" | startswith($p)) or ($p | startswith($base + "/")) end;
      if type != "array" then {error: "the routes response is not an array"}
      elif length >= 100 then {error: "the route list may be truncated at 100 entries"}
      else [ .[] | (.route // .) | select((.source | type) == "string" and (.priority | type) == "number") ]
        | sort_by(.priority) as $all
        | [ $all[] | . as $r | select($probe | test($r.source | glob)) ] as $hits
        | ($hits[0] // null) as $first
        | {route: $first,
           tied: ($hits | length > 1 and .[0].priority == .[1].priority),
           shadow: (if $first == null then null else
             [ $all[] | select(. != $first and .priority <= $first.priority and (.source | under_base)) ][0] end)}
      end' <<<"$ROUTES_JSON" 2>/dev/null)" || ROUTE_EVAL='{"error":"the routes response is not JSON"}'
    FORWARD_ROUTE="$(jq -c '.route // null' <<<"$ROUTE_EVAL")"
    if jq -e 'has("error")' <<<"$ROUTE_EVAL" >/dev/null; then
      FORWARD_PROBLEM="$(jq -r '.error' <<<"$ROUTE_EVAL")"
    elif [ "$FORWARD_ROUTE" = null ]; then
      FORWARD_PROBLEM="no route on the static site matches $PROBE_PATH — missing rewrite"
    elif jq -e '.tied' <<<"$ROUTE_EVAL" >/dev/null; then
      FORWARD_PROBLEM="two routes share the first priority matching $PROBE_PATH — forwarding is ambiguous"
    elif ! jq -e --arg s "$API_BASE/*" '.type == "rewrite" and .source == $s' <<<"$FORWARD_ROUTE" >/dev/null; then
      FORWARD_PROBLEM="the first route matching $PROBE_PATH is $(jq -r '"\(.type) \(.source) -> \(.destination)"' <<<"$FORWARD_ROUTE"), not a rewrite of $API_BASE/* — missing rewrite"
    elif ! jq -e --arg d "$BACKEND_URL/*" '.destination == $d' <<<"$FORWARD_ROUTE" >/dev/null; then
      FORWARD_PROBLEM="the rewrite of $API_BASE/* forwards to $(jq -r '.destination' <<<"$FORWARD_ROUTE"), not $BACKEND_URL/* — wrong forwarding target"
    elif jq -e '.shadow != null' <<<"$ROUTE_EVAL" >/dev/null; then
      FORWARD_PROBLEM="route $(jq -r '.shadow | "\(.type) \(.source) -> \(.destination) (priority \(.priority))"' <<<"$ROUTE_EVAL") is evaluated no later than the rewrite of $API_BASE/* and overlaps it — some API requests would not reach $BACKEND_URL"
    fi
  fi
fi
if [ "$API_MODE" = relative ]; then
  SAME_ORIGIN_URL="$FRONTEND_URL$PROBE_PATH"
  probe_health "$SAME_ORIGIN_URL"
  SAME_ORIGIN_HTTP_CODE="$PROBE_CODE"
  SAME_ORIGIN_COMMIT="$PROBE_COMMIT"
  SAME_ORIGIN_PROBLEM="$PROBE_PROBLEM"
fi

OK=true
REASON=""
if [ "$HTML_FETCH_OK" != true ]; then
  OK=false
  REASON="failed to fetch frontend HTML from $FRONTEND_URL/"
elif [ -z "$BUNDLE_PATH" ]; then
  OK=false
  REASON="could not extract a JS bundle path matching /$BUNDLE_PATTERN/ from the served HTML"
elif [ "$BUNDLE_FETCH_OK" != true ]; then
  OK=false
  REASON="failed to fetch JS bundle from $BUNDLE_URL"
elif [ -n "$SCAN_ERROR" ]; then
  OK=false
  REASON="$SCAN_ERROR"
elif [ "$API_MODE" = direct ] && [ "$EXPECTED_HOST_COUNT" -eq 0 ]; then
  OK=false
  REASON="expected backend host $EXPECTED_HOST does not appear anywhere in the bundle — frontend was not built against this backend"
elif [ "$API_MODE" = relative ] && [ "$API_BASE_REFS" -eq 0 ]; then
  OK=false
  REASON="no scanned bundle quotes the relative API base $API_BASE — frontend was not built against the same-origin proxy"
elif [ "$API_MODE" = relative ] && [ "$EXPECTED_HOST_COUNT" -gt 0 ]; then
  OK=false
  REASON="the bundle names backend host $EXPECTED_HOST directly as well as $API_BASE — clients are split between the proxy and a direct origin"
elif [ "$STALE_FOUND" != '{}' ]; then
  OK=false
  REASON="bundle references a stale/wrong API host: $(jq -c 'keys' <<<"$STALE_FOUND")"
elif [ "$BACKEND_REACHABLE" != true ]; then
  OK=false
  REASON="backend ${BACKEND_URL}${HEALTH_PATH} did not return 200 (frontend build identity is correct, but the backend is not reachable/bound) — got ${BACKEND_HTTP_CODE:-no response}"
elif [ -n "$BACKEND_PROBLEM" ]; then
  OK=false
  REASON="backend ${BACKEND_URL}${HEALTH_PATH} $BACKEND_PROBLEM"
elif [ -n "$FORWARD_PROBLEM" ]; then
  OK=false
  REASON="$FORWARD_PROBLEM"
elif [ -n "$SAME_ORIGIN_PROBLEM" ]; then
  OK=false
  REASON="same-origin health $SAME_ORIGIN_URL $SAME_ORIGIN_PROBLEM"
fi

jq -cn \
  --argjson ok "$OK" \
  --arg frontendUrl "$FRONTEND_URL" \
  --arg backendUrl "$BACKEND_URL" \
  --arg bundleUrl "$BUNDLE_URL" \
  --arg expectedHost "$EXPECTED_HOST" \
  --argjson expectedHostCount "$EXPECTED_HOST_COUNT" \
  --argjson staleHostsFound "$STALE_FOUND" \
  --argjson backendReachable "$BACKEND_REACHABLE" \
  --arg backendHttpCode "$BACKEND_HTTP_CODE" \
  --arg reason "$REASON" \
  --arg apiMode "$API_MODE" \
  --arg apiBase "$API_BASE" \
  --argjson apiBaseRefs "$API_BASE_REFS" \
  --argjson scannedFiles "$SCANNED_FILES" \
  --arg expectedCommit "$EXPECTED_COMMIT" \
  --arg backendCommit "$BACKEND_COMMIT" \
  --arg frontendService "$FRONTEND_SERVICE" \
  --argjson forwardRoute "$FORWARD_ROUTE" \
  --arg sameOriginUrl "$SAME_ORIGIN_URL" \
  --arg sameOriginHttpCode "$SAME_ORIGIN_HTTP_CODE" \
  --arg sameOriginCommit "$SAME_ORIGIN_COMMIT" \
  --arg commitSource "$COMMIT_SOURCE" \
  --arg backendMarker "$BACKEND_MARKER" \
  'def nul: if . == "" then null else . end;
   {ok:$ok, apiMode:$apiMode,
    frontendUrl:$frontendUrl, backendUrl:$backendUrl,
    bundleUrl:($bundleUrl | nul),
    expectedHost:$expectedHost, expectedHostCount:$expectedHostCount,
    staleHostsFound:$staleHostsFound,
    backendReachable:$backendReachable,
    backendHttpCode:($backendHttpCode | nul),
    reason:($reason | nul)}
   + if $apiMode == "relative" then
       {apiBase:$apiBase, apiBaseRefs:$apiBaseRefs, scannedFiles:$scannedFiles,
        expectedCommit:$expectedCommit, backendCommit:($backendCommit | nul),
        frontendService:$frontendService, forwardRoute:$forwardRoute,
        sameOriginUrl:$sameOriginUrl, sameOriginHttpCode:($sameOriginHttpCode | nul),
        sameOriginCommit:($sameOriginCommit | nul)}
     else {} end
   + if $commitSource == "http" then
       {commitSource:$commitSource, backendMarker:$backendMarker,
        expectedCommit:$expectedCommit, backendCommit:($backendCommit | nul)}
     else {} end'

[ "$OK" = true ] && exit 0 || exit 1
