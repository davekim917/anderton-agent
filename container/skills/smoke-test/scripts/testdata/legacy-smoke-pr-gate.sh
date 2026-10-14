#!/usr/bin/env bash
# smoke-pr-gate.sh as an older release shipped it, kept so the tests can replay the
# claims an older running gate writes. Code only: its history named client incidents.
set -u

TAKEOVER=false
_ARGS=()
for _a in "$@"; do
  if [ "$_a" = "--takeover" ]; then TAKEOVER=true; else _ARGS+=("$_a"); fi
done
set -- ${_ARGS[@]+"${_ARGS[@]}"}

REPO="${SMOKE_GATE_REPO:-}"
BRANCH="${SMOKE_GATE_BRANCH:-develop}"
BACKEND_SERVICE="${SMOKE_GATE_BACKEND_SERVICE:-}"
FRONTEND_SERVICE="${SMOKE_GATE_FRONTEND_SERVICE:-}"
LABEL="${SMOKE_GATE_LABEL:-render-preview}"
STATE_DIR="${SMOKE_GATE_STATE_DIR:-/workspace/agent/smoke-gate}"
RUN_PREFIX="${SMOKE_GATE_RUN_PREFIX:-smoke}"
BAD_NUMERIC_CONFIG=""
num_env() {  # <target-var> <env-var-name> <default>
  local raw
  if [ -z "${!2+x}" ]; then printf -v "$1" '%s' "$3"; return; fi
  raw="${!2}"
  case "$raw" in
    0) printf -v "$1" '%s' "$raw"; return ;;
    ''|*[!0-9]*|0*) ;;
    *) if [ "${#raw}" -le 18 ]; then printf -v "$1" '%s' "$raw"; return; fi ;;
  esac
  BAD_NUMERIC_CONFIG="$BAD_NUMERIC_CONFIG $2"
  printf -v "$1" '%s' "$3"
}

num_env ACTIVE_STALE_SECONDS SMOKE_GATE_ACTIVE_STALE_SECONDS 14400
num_env PROGRESS_STALE_SECONDS SMOKE_GATE_PROGRESS_STALE_SECONDS 1800
num_env OVERRUN_REALERT_SECONDS SMOKE_GATE_OVERRUN_REALERT_SECONDS 7200
PREFLIGHT_CMD="${SMOKE_GATE_PREFLIGHT_CMD:-}"
num_env PREFLIGHT_TIMEOUT SMOKE_GATE_PREFLIGHT_TIMEOUT 120
num_env PREFLIGHT_ALERT_SECONDS SMOKE_GATE_PREFLIGHT_ALERT_SECONDS 21600
num_env PREFLIGHT_REARM_FLOOR_SECONDS SMOKE_GATE_PREFLIGHT_REARM_FLOOR_SECONDS 900
num_env WARMUP_TIMEOUT SMOKE_GATE_WARMUP_TIMEOUT 600
num_env FACTS_STUCK_TIMEOUT SMOKE_GATE_FACTS_STUCK_SECONDS 3600
PUBLISH_FILE="${SMOKE_GATE_PUBLISH_FILE:-}"
HOLD_FILE="${SMOKE_GATE_HOLD_FILE:-}"
HANDOFF_LEDGER="${SMOKE_GATE_HANDOFF_LEDGER:-}"

CONTROL_FILE="$STATE_DIR/control.json"
CONTROL_LOCK="$STATE_DIR/control.lock"

FRONTEND_PREFIX="APP-FRONTEND/"
MIGRATIONS_PREFIX="APP-BACKEND/migrations/"
FREEZE_MARKER_BACKEND="APP-BACKEND/.render-freeze"
FREEZE_MARKER_FRONTEND="APP-FRONTEND/.render-freeze"

BUNDLE_PATTERN="${SMOKE_GATE_BUNDLE_PATTERN:-assets/index-[A-Za-z0-9_-]+\.js}"
num_env IDENTITY_TIMEOUT SMOKE_GATE_IDENTITY_TIMEOUT 10

SIZING_RULES="${SMOKE_SIZING_RULES:-/workspace/agent/campaign-sizing.json}"
SIZING_CLASSIFIER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIZING_CLASSIFIER="$SIZING_CLASSIFIER_DIR/campaign-size-classify.py"

mkdir -p "$STATE_DIR"

iso_now() {
  date -u +'%Y-%m-%dT%H:%M:%SZ'
}

epoch_or_zero() {
  local value="$1"
  if [ -n "$value" ] && [ "$value" != "null" ]; then
    date -u -d "$value" +%s 2>/dev/null || printf '0'
  else
    printf '0'
  fi
}

pr_state_file() { printf '%s/pr-%s-state.json' "$STATE_DIR" "$1"; }
pr_lock_file()  { printf '%s/pr-%s-state.lock' "$STATE_DIR" "$1"; }
pr_verdict_file() { printf '%s/pr-%s-verdict.json' "$STATE_DIR" "$1"; }

num_env LOCK_WAIT SMOKE_GATE_LOCK_WAIT_SECONDS 15

run_dir()          { printf '%s/runs/%s' "$STATE_DIR" "$1"; }
run_verdict_file() { printf '%s/runs/%s/verdict.json' "$STATE_DIR" "$1"; }

run_id_ok() { printf '%s' "${1:-}" | grep -Eq '^[A-Za-z0-9._-]{1,200}$' && [ "${1:-}" != ".." ]; }

verdict_payload() {  # <sha> <runId> <verdict> <finishedAt>
  jq -cn --arg sha "$1" --arg run "$2" --arg verdict "$3" --arg now "$4" \
    '{schemaVersion:1,sha:$sha,runId:$run,verdict:$verdict,finishedAt:$now}'
}
verdict_digest() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }

num_env LEASE_TTL_SECONDS SMOKE_GATE_LEASE_TTL_SECONDS 900
DEFAULT_OWNER="${SMOKE_GATE_OWNER:-${HOSTNAME:-unknown-host}}"
SHARED_LEASE_ROOT="${SMOKE_GATE_SHARED_ROOT:-/workspace/workgroup}"
LEASE_DIR="${SMOKE_GATE_LEASE_DIR:-$SHARED_LEASE_ROOT/qa-coordinator/leases}"
LEASE_DIR_PREPARED=false
LEASE_DIR_ERROR=""
LIFECYCLE_FENCE_HELD=false
FENCED_AUTHORITY_JSON=""

new_owner_token() {
  local nonce token
  nonce="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || true)"
  printf '%s' "$nonce" | grep -Eq '^[0-9a-f-]{36}$' || return 1
  token="$(printf '%s:%s:%s' "$nonce" "$$" "$(date -u +%s%N)" | sha256sum | cut -d' ' -f1)"
  [ "${#token}" -eq 64 ] || return 1
  printf 'owner-%s' "$token"
}

lease_dir_prepare() {
  local root ancestor ancestor_real dir probe
  if [ "$LEASE_DIR_PREPARED" = true ]; then return 0; fi
  if [ ! -d "$SHARED_LEASE_ROOT" ]; then
    LEASE_DIR_ERROR="shared lease root $SHARED_LEASE_ROOT is missing"
    return 1
  fi
  if ! command -v mountpoint >/dev/null 2>&1 || ! mountpoint -q "$SHARED_LEASE_ROOT"; then
    LEASE_DIR_ERROR="shared lease root $SHARED_LEASE_ROOT is not a mounted filesystem"
    return 1
  fi
  root="$(cd -P "$SHARED_LEASE_ROOT" 2>/dev/null && pwd -P)" || {
    LEASE_DIR_ERROR="shared lease root $SHARED_LEASE_ROOT cannot be resolved"; return 1; }
  case "$LEASE_DIR" in
    "$SHARED_LEASE_ROOT"/*) ;;
    *) LEASE_DIR_ERROR="configured lease directory $LEASE_DIR is outside $SHARED_LEASE_ROOT"; return 1 ;;
  esac
  ancestor="$LEASE_DIR"
  while [ "$ancestor" != / ] && [ ! -e "$ancestor" ] && [ ! -L "$ancestor" ]; do
    ancestor="$(dirname "$ancestor")"
  done
  ancestor_real="$(cd -P "$ancestor" 2>/dev/null && pwd -P)" || {
    LEASE_DIR_ERROR="configured lease directory has no resolvable ancestor: $ancestor"; return 1; }
  case "$ancestor_real" in
    "$root"|"$root"/*) ;;
    *) LEASE_DIR_ERROR="configured lease directory resolves through non-shared path $ancestor_real"; return 1 ;;
  esac
  if ! mkdir -p -- "$LEASE_DIR" 2>/dev/null; then
    LEASE_DIR_ERROR="could not create shared lease directory $LEASE_DIR"
    return 1
  fi
  dir="$(cd -P "$LEASE_DIR" 2>/dev/null && pwd -P)" || {
    LEASE_DIR_ERROR="could not resolve shared lease directory $LEASE_DIR"; return 1; }
  case "$dir" in
    "$root"/*) ;;
    *) LEASE_DIR_ERROR="configured lease directory resolves outside shared root: $dir"; return 1 ;;
  esac
  probe="$(mktemp "$dir/.lease-probe.XXXXXX" 2>/dev/null)" || {
    LEASE_DIR_ERROR="shared lease directory is not writable: $dir"; return 1; }
  if ! printf 'probe\n' > "$probe" 2>/dev/null || ! rm -f "$probe" 2>/dev/null; then
    rm -f "$probe" 2>/dev/null || true
    LEASE_DIR_ERROR="shared lease directory cannot complete an atomic write: $dir"
    return 1
  fi
  LEASE_DIR="$dir"
  LEASE_DIR_PREPARED=true
}

emit_lease_dir_error() {  # <runId> <command>
  jq -cn --arg run "$1" --arg cmd "$2" --arg dir "$LEASE_DIR" --arg detail "$LEASE_DIR_ERROR" \
    '{ok:false,error:("shared coordinator lease unavailable - " + $detail + "; refusing to continue unleased"),
      runId:$run,command:$cmd,leaseDir:$dir}'
}

lease_file()      { printf '%s/lease-%s.json' "$LEASE_DIR" "$1"; }
lease_lock_file() { printf '%s/lease-%s.lock' "$LEASE_DIR" "$1"; }
lease_lifecycle_lock_file() { printf '%s/pr-%s-lifecycle.lock' "$LEASE_DIR" "$1"; }
pr_authority_file() { printf '%s/pr-%s-authority.json' "$LEASE_DIR" "$1"; }

read_pr_authority() {
  local f; f="$(pr_authority_file "$1")"
  if [ ! -e "$f" ]; then
    printf 'null'
  elif [ -s "$f" ] && jq -e --argjson pr "$1" '
      type == "object" and .schemaVersion == 1 and .pr == $pr and
      (.runId | type == "string" and length > 0) and
      (.owner | type == "string" and length > 0) and
      (.boundAt | type == "string" and length > 0)
    ' "$f" >/dev/null 2>&1; then
    jq -c '.' "$f"
  else
    jq -cn --arg path "$f" '{malformedAuthority:true,path:$path}'
  fi
}

write_pr_authority() { # <pr> <json>
  local tmp
  tmp="$(mktemp "$LEASE_DIR/.pr-$1-authority.XXXXXX" 2>/dev/null)" || return 1
  printf '%s\n' "$2" >"$tmp" 2>/dev/null &&
    mv "$tmp" "$(pr_authority_file "$1")" 2>/dev/null && return 0
  rm -f "$tmp" 2>/dev/null || true
  return 1
}

pr_authority_status() { # <authority-json>: absent|malformed|expired|live
  local authority="$1" run owner lease
  [ "$authority" != null ] || { printf 'absent'; return; }
  jq -e '.malformedAuthority != true' <<<"$authority" >/dev/null 2>&1 || { printf 'malformed'; return; }
  run="$(jq -r '.runId' <<<"$authority")"; owner="$(jq -r '.owner' <<<"$authority")"
  lease="$(read_lease "$run")"
  [ "$(lease_is_malformed "$lease")" != true ] || { printf 'malformed'; return; }
  [ "$lease" != null ] || { printf 'expired'; return; }
  [ "$(jq -r '.owner // empty' <<<"$lease")" = "$owner" ] || { printf 'malformed'; return; }
  [ "$(jq -r '.pr // 0' <<<"$lease")" = "$(jq -r '.pr' <<<"$authority")" ] || { printf 'malformed'; return; }
  if [ "$(lease_is_live "$lease")" = true ]; then printf 'live'; else printf 'expired'; fi
}

bind_pr_authority() { # <pr> <runId> <owner>
  local next
  next="$(jq -cn --argjson pr "$1" --arg run "$2" --arg owner "$3" --arg now "$(iso_now)" \
    '{schemaVersion:1,pr:$pr,runId:$run,owner:$owner,boundAt:$now}')" || return 1
  write_pr_authority "$1" "$next"
}

remove_pr_authority_fenced() { # <pr> <runId> <owner>
  local authority
  authority="$(read_pr_authority "$1")"
  [ "$(jq -r '.runId // empty' <<<"$authority" 2>/dev/null)" = "$2" ] &&
    [ "$(jq -r '.owner // empty' <<<"$authority" 2>/dev/null)" = "$3" ] || return 1
  rm -f "$(pr_authority_file "$1")" 2>/dev/null && [ ! -e "$(pr_authority_file "$1")" ]
}

lease_lifecycle_begin() { # <pr> <runId> <command>
  local pr="$1" run="$2" command="$3"
  if ! lease_dir_prepare; then emit_lease_dir_error "$run" "$command"; return 1; fi
  if ! exec 5>"$(lease_lifecycle_lock_file "$pr")"; then
    jq -cn --argjson pr "$pr" --arg run "$run" --arg dir "$LEASE_DIR" --arg cmd "$command" \
      '{ok:false,error:("could not open shared lifecycle lock under " + $dir + " - refusing to continue unleased"),pr:$pr,runId:$run,command:$cmd,leaseDir:$dir}'
    return 1
  fi
  if ! flock -w "$LOCK_WAIT" 5; then
    jq -cn --argjson pr "$pr" --arg run "$run" --arg cmd "$command" \
      '{ok:false,retryable:true,error:"gate_lock_busy: another invocation held this PR lifecycle fence - RETRY this same command in ~10s.",pr:$pr,runId:$run,command:$cmd}'
    exec 5>&-
    return 1
  fi
  LIFECYCLE_FENCE_HELD=true
}

lease_lifecycle_end() {
  if [ "$LIFECYCLE_FENCE_HELD" = true ]; then
    flock -u 5 2>/dev/null || true
    exec 5>&-
    LIFECYCLE_FENCE_HELD=false
  fi
}

read_lease() {
  local f lease stamp field; f="$(lease_file "$1")"
  if [ ! -e "$f" ]; then
    printf 'null'
  elif [ -s "$f" ] && jq -e '
      type == "object" and .schemaVersion == 1 and
      (.pr | type == "number" and . >= 1 and . == floor) and
      (.owner | type == "string" and length > 0) and
      (.claimedAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
      (.renewedAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
      (.expiresAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
    ' "$f" >/dev/null 2>&1; then
    lease="$(jq -c '.' "$f")"
    for field in claimedAt renewedAt expiresAt; do
      stamp="$(jq -r --arg field "$field" '.[$field]' <<<"$lease")"
      if [ "$(date -u -d "$stamp" +'%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || true)" != "$stamp" ]; then
        jq -cn --arg path "$f" '{malformedLease:true,path:$path}'
        return
      fi
    done
    printf '%s' "$lease"
  else
    jq -cn --arg path "$f" '{malformedLease:true,path:$path}'
  fi
}

lease_is_malformed() {
  jq -e '.malformedLease == true' <<<"${1:-null}" >/dev/null 2>&1 && printf 'true' || printf 'false'
}

lease_is_live() {  # <lease-json>
  local exp
  [ "${1:-null}" != null ] || { printf 'false'; return; }
  exp="$(jq -r '.expiresAt // empty' <<<"$1" 2>/dev/null)"
  if [ -n "$exp" ] && [ "$(date -u +%s)" -lt "$(epoch_or_zero "$exp")" ]; then
    printf 'true'
  else
    printf 'false'
  fi
}

lease_expiry_from_now() {
  date -u -d "@$(( $(date -u +%s) + LEASE_TTL_SECONDS ))" +'%Y-%m-%dT%H:%M:%SZ'
}

write_lease() {  # <runId> <json>
  local tmp
  tmp="$(mktemp "$LEASE_DIR/.lease-$1.XXXXXX" 2>/dev/null)" || return 1
  printf '%s\n' "$2" > "$tmp" 2>/dev/null &&
    mv "$tmp" "$(lease_file "$1")" 2>/dev/null && return 0
  rm -f "$tmp" 2>/dev/null
  return 1
}

lease_acquire() {  # <runId> <owner> <pr> [quiet]
  local run="$1" owner="$2" pr="$3" quiet="${4:-}" cur prior_claimed now next back
  if ! lease_dir_prepare; then
    [ -n "$quiet" ] || emit_lease_dir_error "$run" "lease-claim"
    return 1
  fi
  if ! exec 6>"$(lease_lock_file "$run")"; then
    [ -n "$quiet" ] || jq -cn --arg run "$run" --arg dir "$LEASE_DIR" \
      '{ok:false,error:("could not open shared lease lock under " + $dir + " - refusing to run unleased"),runId:$run,leaseDir:$dir}'
    return 1
  fi
  if ! flock -w "$LOCK_WAIT" 6; then
    [ -n "$quiet" ] || jq -cn --arg run "$run" \
      '{ok:false,retryable:true,
        error:"gate_lock_busy: another invocation held this run'"'"'s lease lock — RETRY this same command in ~10s.",
        runId:$run}'
    exec 6>&-
    return 1
  fi
  cur="$(read_lease "$run")"
  if [ "$(lease_is_malformed "$cur")" = true ]; then
    [ -n "$quiet" ] || jq -cn --arg run "$run" --arg path "$(lease_file "$run")" \
      '{ok:false,error:("shared coordinator lease is malformed at " + $path + " - refusing to overwrite or run unleased"),runId:$run,leaseFile:$path}'
    flock -u 6; exec 6>&-
    return 1
  fi
  if [ "$cur" != null ] && [ "$(jq -r '.pr // 0' <<<"$cur")" != "$pr" ]; then
    [ -n "$quiet" ] || jq -cn --arg run "$run" --arg owner "$owner" --argjson pr "$pr" --argjson lease "$cur" \
      '{ok:false,
        error:("this run id is permanently bound to PR " + ($lease.pr|tostring) +
               " and cannot be reused for PR " + ($pr|tostring)),
        runId:$run,requestedBy:$owner,requestedPr:$pr,
        leasePr:$lease.pr,leaseOwner:$lease.owner,claimedAt:$lease.claimedAt,expiresAt:$lease.expiresAt}'
    flock -u 6; exec 6>&-
    return 1
  fi
  if [ "$(lease_is_live "$cur")" = true ] &&
     [ "$(jq -r '.owner // empty' <<<"$cur")" != "$owner" ]; then
    [ -n "$quiet" ] || jq -cn --arg run "$run" --arg owner "$owner" --argjson pr "$pr" --argjson lease "$cur" \
      '{ok:false,
        error:("this run id is already held for PR " + ($lease.pr|tostring) + " by " + $lease.owner +
               " until " + $lease.expiresAt + " — STOP; another coordinator owns this campaign"),
        runId:$run,requestedBy:$owner,requestedPr:$pr,
        leasePr:$lease.pr,leaseOwner:$lease.owner,claimedAt:$lease.claimedAt,expiresAt:$lease.expiresAt}'
    flock -u 6; exec 6>&-
    return 1
  fi
  prior_claimed=""
  [ "$(jq -r '.owner // empty' <<<"$cur")" = "$owner" ] &&
    prior_claimed="$(jq -r '.claimedAt // empty' <<<"$cur")"
  now="$(iso_now)"
  next="$(jq -cn --arg owner "$owner" --argjson pr "$pr" --arg now "$now" \
    --arg claimed "${prior_claimed:-$now}" --arg exp "$(lease_expiry_from_now)" \
    '{schemaVersion:1,pr:$pr,owner:$owner,claimedAt:$claimed,renewedAt:$now,expiresAt:$exp}')"
  if ! write_lease "$run" "$next"; then
    [ -n "$quiet" ] || jq -cn --arg run "$run" --arg dir "$LEASE_DIR" \
      '{ok:false,error:("could not write the lease file under " + $dir +
                        " - refusing to run unleased. Fix the shared lease dir and retry."),runId:$run,leaseDir:$dir}'
    flock -u 6; exec 6>&-
    return 1
  fi
  back="$(read_lease "$run")"
  if [ "$(jq -r '.owner // empty' <<<"$back")" != "$owner" ] ||
     [ "$(jq -r '.pr // 0' <<<"$back")" != "$pr" ] ||
     [ "$(lease_is_live "$back")" != true ]; then
    [ -n "$quiet" ] || jq -cn --arg run "$run" --arg owner "$owner" --argjson lease "$back" \
      '{ok:false,error:"lease write did not stick (raced by another claimant) — do NOT proceed; retry",
        runId:$run,requestedBy:$owner,lease:$lease}'
    flock -u 6; exec 6>&-
    return 1
  fi
  [ -n "$quiet" ] || jq -cn --arg run "$run" --argjson lease "$back" \
    '{ok:true,runId:$run,lease:$lease}'
  flock -u 6; exec 6>&-
  return 0
}

lease_fence_begin() {  # <pr> <runId> <owner> <command>
  local pr="$1" run="$2" owner="$3" command="$4" lease live lease_owner authority
  if [ "$LIFECYCLE_FENCE_HELD" != true ] && ! lease_lifecycle_begin "$pr" "$run" "$command"; then return 1; fi
  if ! exec 6>"$(lease_lock_file "$run")"; then
    jq -cn --argjson pr "$pr" --arg run "$run" --arg dir "$LEASE_DIR" --arg cmd "$command" \
      '{ok:false,error:("could not open shared run lease lock under " + $dir + " - refusing to continue unleased"),pr:$pr,runId:$run,command:$cmd,leaseDir:$dir}'
    lease_lifecycle_end
    return 1
  fi
  if ! flock -w "$LOCK_WAIT" 6; then
    jq -cn --argjson pr "$pr" --arg run "$run" --arg cmd "$command" \
      '{ok:false,retryable:true,error:"gate_lock_busy: another invocation held this run lease lock - RETRY this same command in ~10s.",pr:$pr,runId:$run,command:$cmd}'
    exec 6>&-; lease_lifecycle_end
    return 1
  fi
  lease="$(read_lease "$run")"
  if [ "$(lease_is_malformed "$lease")" = true ]; then
    jq -cn --argjson pr "$pr" --arg run "$run" --arg cmd "$command" --arg path "$(lease_file "$run")" \
      '{ok:false,error:("shared coordinator lease is malformed at " + $path + " - refusing lifecycle authority"),pr:$pr,runId:$run,command:$cmd,leaseFile:$path}'
    flock -u 6; exec 6>&-; lease_lifecycle_end
    return 1
  fi
  live="$(lease_is_live "$lease")"
  lease_owner="$(jq -r '.owner // empty' <<<"$lease" 2>/dev/null)"
  if [ "$live" != true ] || [ "$lease_owner" != "$owner" ] ||
     [ "$(jq -r '.pr // 0' <<<"$lease" 2>/dev/null)" != "$pr" ]; then
    jq -cn --argjson pr "$pr" --arg run "$run" --arg owner "$owner" --arg cmd "$command" \
      --argjson lease "$lease" --argjson live "$live" \
      '{ok:false,error:"live shared coordinator lease does not belong to this lifecycle owner - STOP this campaign; if this is the original owner after expiry, recover with claim using the same run id and owner token",pr:$pr,runId:$run,command:$cmd,requestedBy:$owner,held:$live,leaseOwner:($lease.owner // null),expiresAt:($lease.expiresAt // null)}'
    flock -u 6; exec 6>&-; lease_lifecycle_end
    return 1
  fi
  authority="$(read_pr_authority "$pr")"
  if [ "$(jq -r '.runId // empty' <<<"$authority" 2>/dev/null)" != "$run" ] ||
     [ "$(jq -r '.owner // empty' <<<"$authority" 2>/dev/null)" != "$owner" ] ||
     [ "$(pr_authority_status "$authority")" != live ]; then
    jq -cn --argjson pr "$pr" --arg run "$run" --arg owner "$owner" --arg cmd "$command" --argjson authority "$authority" \
      '{ok:false,error:"shared PR authority belongs to another run or owner - STOP this campaign",pr:$pr,runId:$run,command:$cmd,requestedBy:$owner,authority:$authority}'
    flock -u 6; exec 6>&-; lease_lifecycle_end
    return 1
  fi
  FENCED_LEASE_JSON="$lease"
  FENCED_AUTHORITY_JSON="$authority"
  return 0
}

lease_fence_end() {
  flock -u 6 2>/dev/null || true; exec 6>&-
  lease_lifecycle_end
  FENCED_AUTHORITY_JSON=""
}

lease_remove_fenced() {  # <runId>
  if ! rm -f "$(lease_file "$1")" 2>/dev/null || [ -e "$(lease_file "$1")" ]; then
    return 1
  fi
}

lease_restore_fenced() {  # <runId> <lease-json>
  local restored
  restored="$(jq -c --arg now "$(iso_now)" --arg exp "$(lease_expiry_from_now)" \
    '.renewedAt=$now | .expiresAt=$exp' <<<"$2")" || return 1
  write_lease "$1" "$restored"
}

rollback_poll_ownership() { # <pr> <runId> <owner> <prior-lease> <prior-authority> <acquired-lease> <acquired-authority>
  local pr="$1" run="$2" owner="$3" prior_lease="$4" prior_authority="$5"
  local acquired_lease="$6" acquired_authority="$7" current current_authority
  lease_lifecycle_begin "$pr" "$run" "poll-rollback" >/dev/null 2>&1 || return 1
  exec 6>"$(lease_lock_file "$run")" || { lease_lifecycle_end; return 1; }
  flock -w "$LOCK_WAIT" 6 || { exec 6>&-; lease_lifecycle_end; return 1; }
  current="$(read_lease "$run")"; current_authority="$(read_pr_authority "$pr")"
  if [ "$current" != "$acquired_lease" ] || [ "$current_authority" != "$acquired_authority" ]; then
    flock -u 6; exec 6>&-; lease_lifecycle_end
    return 0
  fi
  if [ "$prior_lease" = null ]; then rm -f "$(lease_file "$run")" 2>/dev/null
  else write_lease "$run" "$prior_lease"; fi || { flock -u 6; exec 6>&-; lease_lifecycle_end; return 1; }
  if [ "$prior_authority" = null ]; then rm -f "$(pr_authority_file "$pr")" 2>/dev/null
  else write_pr_authority "$pr" "$prior_authority"; fi || { flock -u 6; exec 6>&-; lease_lifecycle_end; return 1; }
  flock -u 6; exec 6>&-; lease_lifecycle_end
}

task_state_file()      { printf '%s/task-%s-state.json' "$STATE_DIR" "$1"; }
task_lease_file()      { printf '%s/task-lease-%s.json' "$LEASE_DIR" "$1"; }
task_lease_lock_file() { printf '%s/task-lease-%s.lock' "$LEASE_DIR" "$1"; }

read_task_lease() {
  local f lease stamp field; f="$(task_lease_file "$1")"
  if [ ! -e "$f" ]; then
    printf 'null'
  elif [ -s "$f" ] && jq -e '
      type == "object" and .schemaVersion == 1 and .kind == "task" and
      (.runId | type == "string" and length > 0) and
      (.deploySha | type == "string" and test("^[0-9a-f]{40}$")) and
      (.owner | type == "string" and length > 0) and
      (.claimedAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
      (.renewedAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
      (.expiresAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
    ' "$f" >/dev/null 2>&1; then
    lease="$(jq -c '.' "$f")"
    for field in claimedAt renewedAt expiresAt; do
      stamp="$(jq -r --arg field "$field" '.[$field]' <<<"$lease")"
      if [ "$(date -u -d "$stamp" +'%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || true)" != "$stamp" ]; then
        jq -cn --arg path "$f" '{malformedLease:true,path:$path}'
        return
      fi
    done
    printf '%s' "$lease"
  else
    jq -cn --arg path "$f" '{malformedLease:true,path:$path}'
  fi
}

write_task_lease() {  # <runId> <json>
  local tmp
  tmp="$(mktemp "$LEASE_DIR/.task-lease-$1.XXXXXX" 2>/dev/null)" || return 1
  printf '%s\n' "$2" > "$tmp" 2>/dev/null &&
    mv "$tmp" "$(task_lease_file "$1")" 2>/dev/null && return 0
  rm -f "$tmp" 2>/dev/null
  return 1
}

task_lease_acquire() {  # <runId> <owner> <deploySha>
  local run="$1" owner="$2" sha="$3" cur prior_claimed now next back
  local verdict_file completed_run recorded completed
  TASK_PRIOR_LEASE_JSON=null
  TASK_ACQUIRED_LEASE_JSON=null
  if ! lease_dir_prepare; then
    emit_lease_dir_error "$run" "task-claim"
    return 1
  fi
  if ! exec 6>"$(task_lease_lock_file "$run")"; then
    jq -cn --arg run "$run" --arg dir "$LEASE_DIR" \
      '{ok:false,error:("could not open shared task lease lock under " + $dir + " - refusing to run unleased"),runId:$run,leaseDir:$dir}'
    return 1
  fi
  if ! flock -w "$LOCK_WAIT" 6; then
    jq -cn --arg run "$run" \
      '{ok:false,retryable:true,
        error:"gate_lock_busy: another invocation held this task run'"'"'s lease lock — RETRY this same command in ~10s.",
        runId:$run}'
    exec 6>&-
    return 1
  fi
  verdict_file="$(run_verdict_file "$run")"
  completed_run="$(jq -r '.completedRunId // empty' "$(task_state_file "$run")" 2>/dev/null || true)"
  if [ "$completed_run" = "$run" ] || [ -e "$verdict_file" ]; then
    recorded="$(jq -c '.' "$verdict_file" 2>/dev/null || true)"
    completed=false; [ "$completed_run" = "$run" ] && completed=true
    if [ "$completed" = true ] || [ -z "$recorded" ] ||
       ! jq -e --arg sha "$sha" --arg run "$run" '.sha == $sha and .runId == $run' <<<"$recorded" >/dev/null 2>&1; then
      jq -cn --arg run "$run" --arg owner "$owner" --arg sha "$sha" --arg path "$verdict_file" \
        --argjson completed "$completed" \
        --argjson recorded "$(if [ -n "$recorded" ]; then printf '%s' "$recorded"; elif [ -e "$verdict_file" ]; then printf '"unparseable"'; else printf 'null'; fi)" \
        '{ok:false,
          error:(if $completed
                 then "this task run already finished — a finished run id is terminal and can never be re-claimed, for this build or any other; start a new run id"
                 else "a verdict is already recorded for this task run on a different build, or cannot be read — it cannot be re-claimed for deploy " + $sha + "; start a new run id for a new build"
                 end),
          runId:$run,requestedBy:$owner,requestedSha:$sha,finished:$completed,
          runVerdictFile:$path,recordedVerdict:$recorded}'
      flock -u 6; exec 6>&-
      return 1
    fi
  fi
  cur="$(read_task_lease "$run")"
  if [ "$(lease_is_malformed "$cur")" = true ]; then
    jq -cn --arg run "$run" --arg path "$(task_lease_file "$run")" \
      '{ok:false,error:("shared task lease is malformed at " + $path + " - refusing to overwrite or run unleased"),runId:$run,leaseFile:$path}'
    flock -u 6; exec 6>&-
    return 1
  fi
  if [ "$cur" != null ] && [ "$(jq -r '.deploySha // empty' <<<"$cur")" != "$sha" ]; then
    jq -cn --arg run "$run" --arg owner "$owner" --arg sha "$sha" --argjson lease "$cur" \
      '{ok:false,
        error:("this run id is permanently bound to deploy " + $lease.deploySha +
               " and cannot be reused for deploy " + $sha +
               " — a task-scoped run id is one build for its whole lifetime; start a new run id for a new build"),
        runId:$run,requestedBy:$owner,requestedSha:$sha,
        leaseSha:$lease.deploySha,leaseOwner:$lease.owner,claimedAt:$lease.claimedAt,expiresAt:$lease.expiresAt}'
    flock -u 6; exec 6>&-
    return 1
  fi
  if [ "$(lease_is_live "$cur")" = true ] &&
     [ "$(jq -r '.owner // empty' <<<"$cur")" != "$owner" ]; then
    if [ "$TAKEOVER" != true ]; then
      jq -cn --arg run "$run" --arg owner "$owner" --argjson lease "$cur" \
        '{ok:false,
          error:("this task run is already held by " + $lease.owner + " until " + $lease.expiresAt +
                 " — STOP; another coordinator owns this run, or re-run with --takeover to force it"),
          runId:$run,requestedBy:$owner,leaseOwner:$lease.owner,claimedAt:$lease.claimedAt,expiresAt:$lease.expiresAt}'
      flock -u 6; exec 6>&-
      return 1
    fi
  fi
  prior_claimed=""
  [ "$(jq -r '.owner // empty' <<<"$cur")" = "$owner" ] &&
    prior_claimed="$(jq -r '.claimedAt // empty' <<<"$cur")"
  now="$(iso_now)"
  next="$(jq -cn --arg run "$run" --arg owner "$owner" --arg sha "$sha" --arg now "$now" \
    --arg claimed "${prior_claimed:-$now}" --arg exp "$(lease_expiry_from_now)" \
    '{schemaVersion:1,kind:"task",runId:$run,deploySha:$sha,owner:$owner,claimedAt:$claimed,renewedAt:$now,expiresAt:$exp}')"
  if ! write_task_lease "$run" "$next"; then
    jq -cn --arg run "$run" --arg dir "$LEASE_DIR" \
      '{ok:false,error:("could not write the task lease file under " + $dir +
                        " - refusing to run unleased. Fix the shared lease dir and retry."),runId:$run,leaseDir:$dir}'
    flock -u 6; exec 6>&-
    return 1
  fi
  back="$(read_task_lease "$run")"
  if [ "$(jq -r '.owner // empty' <<<"$back")" != "$owner" ] ||
     [ "$(jq -r '.deploySha // empty' <<<"$back")" != "$sha" ] ||
     [ "$(lease_is_live "$back")" != true ]; then
    jq -cn --arg run "$run" --arg owner "$owner" --argjson lease "$back" \
      '{ok:false,error:"task lease write did not stick (raced by another claimant) — do NOT proceed; retry",
        runId:$run,requestedBy:$owner,lease:$lease}'
    flock -u 6; exec 6>&-
    return 1
  fi
  TASK_PRIOR_LEASE_JSON="$cur"
  TASK_ACQUIRED_LEASE_JSON="$back"
  return 0  # fd 6 is still held — the caller ends it (see above)
}

task_lease_fence_begin() {  # <runId> <owner> <command>
  local run="$1" owner="$2" command="$3" lease live lease_owner
  if ! exec 6>"$(task_lease_lock_file "$run")"; then
    jq -cn --arg run "$run" --arg dir "$LEASE_DIR" --arg cmd "$command" \
      '{ok:false,error:("could not open shared task lease lock under " + $dir + " - refusing to continue unleased"),runId:$run,command:$cmd,leaseDir:$dir}'
    return 1
  fi
  if ! flock -w "$LOCK_WAIT" 6; then
    jq -cn --arg run "$run" --arg cmd "$command" \
      '{ok:false,retryable:true,error:"gate_lock_busy: another invocation held this task run lease lock - RETRY this same command in ~10s.",runId:$run,command:$cmd}'
    exec 6>&-
    return 1
  fi
  lease="$(read_task_lease "$run")"
  if [ "$(lease_is_malformed "$lease")" = true ]; then
    jq -cn --arg run "$run" --arg cmd "$command" --arg path "$(task_lease_file "$run")" \
      '{ok:false,error:("shared task lease is malformed at " + $path + " - refusing lifecycle authority"),runId:$run,command:$cmd,leaseFile:$path}'
    flock -u 6; exec 6>&-
    return 1
  fi
  live="$(lease_is_live "$lease")"
  lease_owner="$(jq -r '.owner // empty' <<<"$lease" 2>/dev/null)"
  if [ "$live" != true ] || [ "$lease_owner" != "$owner" ]; then
    jq -cn --arg run "$run" --arg owner "$owner" --arg cmd "$command" --argjson lease "$lease" --argjson live "$live" \
      '{ok:false,error:"live shared task lease does not belong to this lifecycle owner - STOP this run; if this is the original owner after expiry, recover with task-claim using the same run id, owner token and deploy SHA",runId:$run,command:$cmd,requestedBy:$owner,held:$live,leaseOwner:($lease.owner // null),expiresAt:($lease.expiresAt // null)}'
    flock -u 6; exec 6>&-
    return 1
  fi
  FENCED_TASK_LEASE_JSON="$lease"
  return 0
}

task_lease_fence_end() {
  flock -u 6 2>/dev/null || true; exec 6>&-
}

task_lease_remove_fenced() {  # <runId>
  if ! rm -f "$(task_lease_file "$1")" 2>/dev/null || [ -e "$(task_lease_file "$1")" ]; then
    return 1
  fi
}

num_env CHALLENGER_TIMEOUT_SECONDS SMOKE_GATE_CHALLENGER_TIMEOUT_SECONDS 5400
CHALLENGER_RUN_ROOT="${SMOKE_GATE_RUN_ROOT:-}"
challenger_disposition_file() { printf '%s/%s/challenger/disposition.md' "$CHALLENGER_RUN_ROOT" "$1"; }
challenger_deadline_from_now() {
  date -u -d "@$(( $(date -u +%s) + CHALLENGER_TIMEOUT_SECONDS ))" +'%Y-%m-%dT%H:%M:%SZ'
}

emit_lock_busy() {
  jq -cn --arg phase "$1" --arg pr "${2:-}" \
    '{ok:false,
      retryable:true,
      error:("gate_lock_busy: another gate invocation held the state lock (" + $phase +
             ") — RETRY this same command in ~10s. This does NOT mean the run lost its slot; do not stop the campaign."),
      pr:(if $pr == "" then null else ($pr|tonumber) end),
      wakeAgent:false,
      data:{schemaVersion:1,trigger:"gate_lock_busy",phase:$phase}}'
}

default_pr_state() {
  jq -cn --argjson pr "$1" '{
    schemaVersion: 1,
    pr: $pr,
    activeSha: null,
    activeStartedAt: null,
    activeRunId: null,
    activeProgressAt: null,
    activeLeaseOwner: null,
    completedSha: null,
    completedAt: null,
    completedRunId: null,
    completedVerdict: null,
    deployLiveSha: null,
    deployLiveSince: null,
    warmupAlertSha: null,
    refusedAlertSha: null,
    factsStuckSha: null,
    factsStuckSince: null,
    factsStuckAlertSha: null,
    overrunAlertRunId: null,
    overrunAlertAt: null,
    displacedRunId: null,
    displacedAt: null,
    finishIntent: null,
    completedVerdictDigest: null,
    gateStatus: null,
    reconciliation: null,
    challengerDeadline: null,
    challengerDisposition: null,
    challengerTimedOutAt: null
  }'
}

read_pr_state() {
  local n="$1" f
  f="$(pr_state_file "$n")"
  if [ -s "$f" ] && jq -e 'type == "object"' "$f" >/dev/null 2>&1; then
    jq -c '.' "$f"
  else
    default_pr_state "$n"
  fi
}

write_pr_state() {
  local n="$1" next="$2" tmp
  tmp="$(mktemp "$STATE_DIR/.pr-$n-state.XXXXXX" 2>/dev/null)" || return 1
  if ! printf '%s\n' "$next" > "$tmp" 2>/dev/null ||
     ! mv "$tmp" "$(pr_state_file "$n")" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null || true
    return 1
  fi
}

default_control() {
  jq -cn '{
    schemaVersion: 1,
    fetchFailures: 0,
    lastFailureWakeAt: null,
    lastMisconfigWakeAt: null,
    leaseFailureFingerprint: null,
    leaseFailureWakeAt: null,
    preflightReason: null,
    preflightWakeAt: null,
    preflightFingerprint: null
  }'
}

read_control() {
  if [ -s "$CONTROL_FILE" ] && jq -e 'type == "object"' "$CONTROL_FILE" >/dev/null 2>&1; then
    jq -c '.' "$CONTROL_FILE"
  else
    default_control
  fi
}

write_control() {
  local next="$1" tmp
  tmp="$(mktemp "$STATE_DIR/.control.XXXXXX")"
  printf '%s\n' "$next" > "$tmp"
  mv "$tmp" "$CONTROL_FILE"
}

emit_poll_lease_failure() { # <detail-json>
  local detail="$1" fingerprint last now wake=false control
  if jq -e '(.leaseOwner // null) != null or .retryable == true' <<<"$detail" >/dev/null 2>&1; then
    jq -cn --argjson detail "$detail" \
      '{ok:false,wakeAgent:false,data:{schemaVersion:1,trigger:"coordinator_lease_unavailable",detail:$detail}}'
    return
  fi
  fingerprint="$(jq -r '.error // "unknown shared lease failure"' <<<"$detail" | sha256sum | cut -d' ' -f1)"
  exec 4>"$CONTROL_LOCK"
  if flock -w 5 4; then
    control="$(read_control)"
    last="$(epoch_or_zero "$(jq -r --arg fp "$fingerprint" 'if .leaseFailureFingerprint == $fp then .leaseFailureWakeAt // empty else empty end' <<<"$control")")"
    now="$(date -u +%s)"
    if [ "$(( now - last ))" -ge 21600 ]; then wake=true; fi
    control="$(jq -c --arg fp "$fingerprint" --arg at "$(iso_now)" --argjson wake "$wake" \
      '.leaseFailureFingerprint=$fp | if $wake then .leaseFailureWakeAt=$at else . end' <<<"$control")"
    write_control "$control" || wake=true
    flock -u 4
  else
    wake=true
  fi
  exec 4>&-
  jq -cn --argjson wake "$wake" --argjson detail "$detail" \
    '{ok:false,wakeAgent:$wake,data:{schemaVersion:1,trigger:"coordinator_lease_unavailable",detail:$detail}}'
}

active_run_is_live() {
  local started="$1" progress="$2" now_epoch started_epoch progress_epoch last quiet
  now_epoch="$(date -u +%s)"
  started_epoch="$(epoch_or_zero "$started")"
  progress_epoch="$(epoch_or_zero "$progress")"
  last="$started_epoch"
  if [ "$progress_epoch" -gt "$last" ]; then last="$progress_epoch"; fi
  quiet="$(( now_epoch - last ))"
  if [ "$quiet" -lt "$PROGRESS_STALE_SECONDS" ]; then
    printf 'true'
  else
    printf 'false'
  fi
}

active_run_age() {
  printf '%s' "$(( $(date -u +%s) - $(epoch_or_zero "$1") ))"
}

emit_not_active() {
  local run_id="$1" base="$2" f
  for f in "$STATE_DIR"/pr-*-state.json; do
    [ -e "$f" ] || continue
    if [ "$(jq -r '.displacedRunId // empty' "$f" 2>/dev/null)" = "$run_id" ]; then
      jq -cn --arg run "$run_id" \
        --argjson pr "$(jq -r '.pr' "$f")" \
        --arg by "$(jq -r '.activeRunId // empty' "$f")" \
        --arg at "$(jq -r '.displacedAt // empty' "$f")" \
        '{ok:false,
          error:("STOP THIS CAMPAIGN. This run was displaced by an explicit --takeover at " + $at +
                 " and no longer owns the PR: stop every lane, write no markers, drive no browsers, publish nothing."),
          runId:$run,pr:$pr,activeRunId:(if $by == "" then null else $by end),displacedAt:$at}'
      return 0
    fi
  done
  jq -cn --arg run "$run_id" --arg base "$base" \
    '{ok:false,error:$base,runId:(if $run == "" then null else $run end),pr:null,activeRunId:null}'
}

find_pr_for_run() {
  local run_id="$1" f pr
  for f in "$STATE_DIR"/pr-*-state.json; do
    [ -e "$f" ] || continue
    if [ "$(jq -r '.activeRunId // empty' "$f" 2>/dev/null)" = "$run_id" ]; then
      pr="$(jq -r '.pr' "$f" 2>/dev/null)"
      [ -n "$pr" ] && [ "$pr" != "null" ] && { printf '%s' "$pr"; return 0; }
    fi
  done
  return 1
}

find_pr_for_any_run() {
  local run_id="$1" f pr
  for f in "$STATE_DIR"/pr-*-state.json; do
    [ -e "$f" ] || continue
    if jq -e --arg r "$run_id" \
         '(.activeRunId // "") == $r or (.completedRunId // "") == $r or ((.finishIntent.runId // "") == $r)' \
         "$f" >/dev/null 2>&1; then
      pr="$(jq -r '.pr' "$f" 2>/dev/null)"
      [ -n "$pr" ] && [ "$pr" != "null" ] && { printf '%s' "$pr"; return 0; }
    fi
  done
  return 1
}

fetch_services() {
  timeout 10 curl -fsS --max-time 10 "https://api.render.com/v1/services?limit=100" 2>/dev/null
}

find_preview_candidates() {
  local services_json="$1" parent_id="$2" pr="$3"
  jq -c --arg pid "$parent_id" --arg suffix "PR #$pr" '
    [.[]? | (.service // .) | select(.serviceDetails.parentServer.id == $pid) | select(.name | endswith($suffix))
     | {id:(.id // null), name:(.name // null), url:(.serviceDetails.url // null)}]
  ' <<<"$services_json" 2>/dev/null
}

resolve_backend_by_bundle() {
  local frontend_url="$1" candidates_json="$2"
  local tmp html_file bundle_path bundle_url bundle_file

  if [ -z "$frontend_url" ] || [ "$frontend_url" = "null" ]; then
    jq -cn '{resolved:null, reason:"no healthy frontend preview URL available to disambiguate against"}'
    return 0
  fi

  tmp="$(mktemp -d)"
  html_file="$tmp/index.html"
  if ! timeout "$IDENTITY_TIMEOUT" curl -fsS --max-time "$IDENTITY_TIMEOUT" "${frontend_url%/}/" >"$html_file" 2>/dev/null; then
    rm -rf "$tmp"
    jq -cn '{resolved:null, reason:"failed to fetch the served frontend HTML to disambiguate"}'
    return 0
  fi

  bundle_path="$(grep -oE "$BUNDLE_PATTERN" "$html_file" 2>/dev/null | head -1)"
  if [ -z "$bundle_path" ]; then
    rm -rf "$tmp"
    jq -cn '{resolved:null, reason:"could not extract a JS bundle path from the served frontend HTML"}'
    return 0
  fi

  bundle_url="${frontend_url%/}/$bundle_path"
  bundle_file="$tmp/bundle.js"
  if ! timeout "$IDENTITY_TIMEOUT" curl -fsS --max-time "$IDENTITY_TIMEOUT" "$bundle_url" >"$bundle_file" 2>/dev/null; then
    rm -rf "$tmp"
    jq -cn '{resolved:null, reason:"failed to fetch the served JS bundle to disambiguate"}'
    return 0
  fi

  local n idx url host count matched=0 match_json=null
  n="$(jq 'length' <<<"$candidates_json")"
  for (( idx=0; idx<n; idx++ )); do
    url="$(jq -r ".[$idx].url // empty" <<<"$candidates_json")"
    [ -n "$url" ] || continue
    host="$(printf '%s' "$url" | sed -E 's#^https?://##; s#/.*$##')"
    [ -n "$host" ] || continue
    count="$(grep -cF -- "$host" "$bundle_file" 2>/dev/null)"
    [ -n "$count" ] || count=0
    if [ "$count" -gt 0 ]; then
      matched=$((matched + 1))
      match_json="$(jq -c ".[$idx]" <<<"$candidates_json")"
    fi
  done
  rm -rf "$tmp"

  if [ "$matched" -eq 1 ]; then
    jq -cn --argjson c "$match_json" '{resolved:$c, reason:null}'
  elif [ "$matched" -eq 0 ]; then
    jq -cn '{resolved:null, reason:"the served bundle references none of the candidate backend hosts"}'
  else
    jq -cn '{resolved:null, reason:"the served bundle references more than one candidate backend host"}'
  fi
}

resolve_backend_identity() {
  local services_json="$1" pr="$2" frontend_url="$3"
  local candidates n disambig resolved reason full_reason
  candidates="$(find_preview_candidates "$services_json" "$BACKEND_SERVICE" "$pr")"
  n="$(jq 'length' <<<"$candidates")"
  if [ "$n" -eq 0 ]; then
    jq -cn --argjson c "$candidates" '{selected:null, method:"none", candidates:$c, reason:null}'
    return 0
  fi
  if [ "$n" -eq 1 ]; then
    jq -cn --argjson c "$candidates" '{selected:$c[0], method:"single", candidates:$c, reason:null}'
    return 0
  fi
  disambig="$(resolve_backend_by_bundle "$frontend_url" "$candidates")"
  resolved="$(jq -c '.resolved' <<<"$disambig")"
  if [ "$resolved" != null ]; then
    jq -cn --argjson c "$candidates" --argjson sel "$resolved" \
      '{selected:$sel, method:"bundle-disambiguated", candidates:$c, reason:null}'
    return 0
  fi
  reason="$(jq -r '.reason // "ambiguous"' <<<"$disambig")"
  full_reason="$(jq -r --arg pr "$pr" --arg why "$reason" '
    "refusing to select a backend preview for PR #" + $pr + ": " +
    (length | tostring) + " services share that name — " +
    ([.[] | ((.name // "unnamed") + " (" + (.id // "no id") + ")")] | join(", ")) +
    ". " + $why + "."
  ' <<<"$candidates")"
  jq -cn --argjson c "$candidates" --arg reason "$full_reason" \
    '{selected:null, method:"ambiguous", candidates:$c, reason:$reason}'
}

resolve_frontend_identity() {
  local services_json="$1" pr="$2"
  local candidates n full_reason
  candidates="$(find_preview_candidates "$services_json" "$FRONTEND_SERVICE" "$pr")"
  n="$(jq 'length' <<<"$candidates")"
  if [ "$n" -eq 0 ]; then
    jq -cn --argjson c "$candidates" '{selected:null, method:"none", candidates:$c, reason:null}'
  elif [ "$n" -eq 1 ]; then
    jq -cn --argjson c "$candidates" '{selected:$c[0], method:"single", candidates:$c, reason:null}'
  else
    full_reason="$(jq -r --arg pr "$pr" '
      "refusing to select a frontend preview for PR #" + $pr + ": " +
      (length | tostring) + " services share that name — " +
      ([.[] | ((.name // "unnamed") + " (" + (.id // "no id") + ")")] | join(", ")) +
      ". No disambiguation oracle exists for the frontend side."
    ' <<<"$candidates")"
    jq -cn --argjson c "$candidates" --arg reason "$full_reason" \
      '{selected:null, method:"ambiguous", candidates:$c, reason:$reason}'
  fi
}

latest_live_deploy_sha() {
  local service_id="$1" out
  out="$(timeout 10 curl -fsS --max-time 10 "https://api.render.com/v1/services/$service_id/deploys?limit=5" 2>/dev/null)" || return 1
  jq -r '[.[]? | (.deploy // .) | select(.status == "live")][0].commit.id // empty' <<<"$out" 2>/dev/null
}

healthz_ok() {
  local url="$1" code
  [ -n "$url" ] && [ "$url" != "null" ] || return 1
  code="$(timeout 10 curl -fsS -o /dev/null -w '%{http_code}' --max-time 10 "${url%/}/healthz" 2>/dev/null)" || return 1
  [ "$code" = "200" ]
}

campaign_size_classify() {
  local determinable="$1" fail_reason="$2" changed_files_json="${3:-[]}"
  local rules_path="$SIZING_RULES" out
  if [ "$determinable" != true ]; then
    jq -cn --arg reason "$fail_reason" '{campaignSize:"full", sizeReason:("full: " + $reason)}'
    return 0
  fi
  if ! out="$(printf '%s' "$changed_files_json" | timeout 10 python3 "$SIZING_CLASSIFIER" "$rules_path" 2>/dev/null)" ||
     ! jq -e 'type == "object" and (.campaignSize | type == "string") and (.sizeReason | type == "string")' \
       <<<"$out" >/dev/null 2>&1; then
    jq -cn '{campaignSize:"full", sizeReason:"full: campaign size classifier failed"}'
    return 0
  fi
  printf '%s' "$out"
}

evaluate_pr() {
  local pr="$1" head_sha="$2" head_ref="${3:-}"
  local files_json files_len files_fetch_failed migrations_touched frontend_touched frontend_required is_freeze ci_sha
  local migration_files migrations_determinable target_files_json target_files_len target_compare_failed
  local runs_json runs_len ci_total ci_pending ci_failed ci_succeeded ci_ready ci_truncated
  local services_json backend backend_id backend_url backend_deploy_sha backend_ready
  local frontend frontend_id frontend_url frontend_deploy_sha frontend_ready
  local frontend_identity frontend_method frontend_candidates_json
  local backend_identity backend_method backend_candidates_json
  local preview_ambiguous preview_ambiguity_text frontend_evidence_gap FR_REASON
  local healthz_ready settled fetch_ok=true

  files_fetch_failed=false
  if ! files_json="$(timeout 10 gh api "repos/$REPO/pulls/$pr/files?per_page=100" 2>/dev/null)" ||
     ! jq -e 'type == "array"' <<<"$files_json" >/dev/null 2>&1; then
    fetch_ok=false
    files_json='[]'
    files_fetch_failed=true
  fi
  files_len="$(jq -r 'length' <<<"$files_json" 2>/dev/null || printf 0)"
  if [ "$files_fetch_failed" = true ] || { [ "$files_len" -ge 100 ] 2>/dev/null; }; then
    migrations_touched=true
    frontend_touched=true
  else
    migrations_touched="$(jq -r --arg p "$MIGRATIONS_PREFIX" 'any(.[].filename; startswith($p))' <<<"$files_json" 2>/dev/null)"
    frontend_touched="$(jq -r --arg p "$FRONTEND_PREFIX" 'any(.[].filename; startswith($p))' <<<"$files_json" 2>/dev/null)"
    [ "$migrations_touched" = true ] || [ "$migrations_touched" = false ] || migrations_touched=true
    [ "$frontend_touched" = true ] || [ "$frontend_touched" = false ] || frontend_touched=true
  fi
  is_freeze="$(jq -r --arg a "$FREEZE_MARKER_BACKEND" --arg b "$FREEZE_MARKER_FRONTEND" '
    (length == 2) and ((map(.filename) | sort) == ([$a,$b] | sort))
  ' <<<"$files_json" 2>/dev/null)"
  [ "$is_freeze" = true ] || is_freeze=false

  if [ "$is_freeze" = true ]; then
    ci_sha="$(timeout 8 gh api "repos/$REPO/commits/$head_sha" --jq '.parents[0].sha // empty' 2>/dev/null)"
    [ -n "$ci_sha" ] || { ci_sha=""; fetch_ok=false; }
  else
    ci_sha="$head_sha"
  fi

  migrations_determinable=true
  migration_files='[]'
  if [ "$is_freeze" = true ]; then
    if [ -z "$ci_sha" ]; then
      migrations_touched=true
      frontend_touched=true
      migrations_determinable=false
    else
      target_compare_failed=false
      if ! target_files_json="$(timeout 10 gh api "repos/$REPO/compare/$BRANCH...$ci_sha" 2>/dev/null)" ||
         ! jq -e '.files | type == "array"' <<<"$target_files_json" >/dev/null 2>&1; then
        target_compare_failed=true
        target_files_json='{"files":[]}'
      fi
      target_files_len="$(jq -r '.files | length' <<<"$target_files_json" 2>/dev/null || printf -- '-1')"
      if [ "$target_compare_failed" = true ] || { [ "$target_files_len" -ge 300 ] 2>/dev/null; }; then
        migrations_touched=true
        frontend_touched=true
        migrations_determinable=false
        fetch_ok=false
      else
        migrations_touched="$(jq -r --arg p "$MIGRATIONS_PREFIX" 'any(.files[].filename; startswith($p))' <<<"$target_files_json" 2>/dev/null)"
        frontend_touched="$(jq -r --arg p "$FRONTEND_PREFIX" 'any(.files[].filename; startswith($p))' <<<"$target_files_json" 2>/dev/null)"
        [ "$migrations_touched" = true ] || [ "$migrations_touched" = false ] || { migrations_touched=true; migrations_determinable=false; }
        [ "$frontend_touched" = true ] || [ "$frontend_touched" = false ] || frontend_touched=true
        migration_files="$(jq -c --arg p "$MIGRATIONS_PREFIX" '[.files[].filename | select(startswith($p))]' <<<"$target_files_json" 2>/dev/null)"
        [ -n "$migration_files" ] && jq -e 'type == "array"' <<<"$migration_files" >/dev/null 2>&1 || migration_files='[]'
      fi
    fi
  elif [ "$files_fetch_failed" = true ] || { [ "$files_len" -ge 100 ] 2>/dev/null; }; then
    migrations_determinable=false
  else
    migration_files="$(jq -c --arg p "$MIGRATIONS_PREFIX" '[.[].filename | select(startswith($p))]' <<<"$files_json" 2>/dev/null)"
    [ -n "$migration_files" ] && jq -e 'type == "array"' <<<"$migration_files" >/dev/null 2>&1 || migration_files='[]'
  fi

  local size_files_json='[]' size_determinable=true size_fail_reason=""
  if [ "$is_freeze" = true ]; then
    if [ -z "$ci_sha" ]; then
      size_determinable=false
      size_fail_reason="the freeze target commit could not be determined"
    elif [ "$target_compare_failed" = true ]; then
      size_determinable=false
      size_fail_reason="the freeze target diff could not be fetched"
    elif { [ "$target_files_len" -ge 300 ] 2>/dev/null; }; then
      size_determinable=false
      size_fail_reason="the freeze target diff is truncated (>=300 files)"
    else
      size_files_json="$(jq -c '[.files[] | .filename, (.previous_filename // empty)]' <<<"$target_files_json" 2>/dev/null || printf '[]')"
    fi
  else
    if [ "$files_fetch_failed" = true ]; then
      size_determinable=false
      size_fail_reason="the PR file list could not be fetched"
    elif { [ "$files_len" -ge 100 ] 2>/dev/null; }; then
      size_determinable=false
      size_fail_reason="the PR file list is truncated (>=100 files)"
    else
      size_files_json="$(jq -c '[.[] | .filename, (.previous_filename // empty)]' <<<"$files_json" 2>/dev/null || printf '[]')"
    fi
  fi
  local size_out campaign_size campaign_size_reason
  size_out="$(campaign_size_classify "$size_determinable" "$size_fail_reason" "$size_files_json")"
  campaign_size="$(jq -r '.campaignSize' <<<"$size_out")"
  campaign_size_reason="$(jq -r '.sizeReason' <<<"$size_out")"

  frontend_required="$frontend_touched"
  if [ "$is_freeze" = true ]; then frontend_required=true; fi

  ci_ready=false
  ci_total=0; ci_pending=0; ci_failed=0; ci_succeeded=0; ci_truncated=false
  if [ -n "$ci_sha" ]; then
    if runs_json="$(timeout 10 gh api "repos/$REPO/actions/runs?head_sha=$ci_sha&per_page=100" \
         --jq '[.workflow_runs[] | {headSha: .head_sha, status, conclusion, workflowName: .name}]' 2>/dev/null)" &&
       jq -e 'type == "array"' <<<"$runs_json" >/dev/null 2>&1; then
      runs_len="$(jq -r 'length' <<<"$runs_json")"
      ci_total="$(jq -r --arg s "$ci_sha" '[.[] | select(.headSha == $s)] | length' <<<"$runs_json")"
      if [ "$runs_len" -ge 100 ] && [ "$ci_total" -eq 0 ]; then
        ci_truncated=true
        fetch_ok=false
      else
        ci_pending="$(jq -r --arg s "$ci_sha" '[.[] | select(.headSha == $s and .status != "completed")] | length' <<<"$runs_json")"
        ci_failed="$(jq -r --arg s "$ci_sha" '[.[] | select(.headSha == $s) | select((.conclusion // "") as $c | (["success","skipped","neutral"] | index($c) | not))] | length' <<<"$runs_json")"
        ci_succeeded="$(jq -r --arg s "$ci_sha" '[.[] | select(.headSha == $s and .status == "completed" and .conclusion == "success")] | length' <<<"$runs_json")"
        if [ "$ci_total" -gt 0 ] && [ "$ci_succeeded" -gt 0 ] && [ "$ci_pending" -eq 0 ] && [ "$ci_failed" -eq 0 ]; then
          ci_ready=true
        fi
      fi
    else
      fetch_ok=false
    fi
  fi

  if ! services_json="$(fetch_services)" || ! jq -e 'type == "array"' <<<"$services_json" >/dev/null 2>&1; then
    fetch_ok=false
    services_json='[]'
  fi

  frontend_identity="$(resolve_frontend_identity "$services_json" "$pr")"
  frontend_method="$(jq -r '.method' <<<"$frontend_identity")"
  frontend="$(jq -c '.selected' <<<"$frontend_identity")"
  frontend_candidates_json="$(jq -c '.candidates' <<<"$frontend_identity")"
  frontend_id=""; frontend_url=""
  if [ "$frontend" != "null" ]; then
    frontend_id="$(jq -r '.id // empty' <<<"$frontend")"
    frontend_url="$(jq -r '.url // empty' <<<"$frontend")"
  fi

  backend_identity="$(resolve_backend_identity "$services_json" "$pr" "$frontend_url")"
  backend_method="$(jq -r '.method' <<<"$backend_identity")"
  backend="$(jq -c '.selected' <<<"$backend_identity")"
  backend_candidates_json="$(jq -c '.candidates' <<<"$backend_identity")"
  backend_id=""; backend_url=""; backend_deploy_sha=""; backend_ready=false
  if [ "$backend" != "null" ]; then
    backend_id="$(jq -r '.id // empty' <<<"$backend")"
    backend_url="$(jq -r '.url // empty' <<<"$backend")"
    if [ -n "$backend_id" ]; then
      backend_deploy_sha="$(latest_live_deploy_sha "$backend_id")" || { backend_deploy_sha=""; fetch_ok=false; }
      [ "$backend_deploy_sha" = "$head_sha" ] && backend_ready=true
    fi
  fi

  preview_ambiguous=false
  preview_ambiguity_text=""
  if [ "$backend_method" = "ambiguous" ]; then
    preview_ambiguous=true
    fetch_ok=false
    preview_ambiguity_text="$(jq -r '.reason' <<<"$backend_identity")"
    printf 'smoke-pr-gate: %s\n' "$preview_ambiguity_text" >&2
  fi
  if [ "$frontend_method" = "ambiguous" ]; then
    preview_ambiguous=true
    FR_REASON="$(jq -r '.reason' <<<"$frontend_identity")"
    if [ -n "$preview_ambiguity_text" ]; then
      preview_ambiguity_text="$preview_ambiguity_text; $FR_REASON"
    else
      preview_ambiguity_text="$FR_REASON"
    fi
    printf 'smoke-pr-gate: %s\n' "$FR_REASON" >&2
  fi

  frontend_ready=true
  frontend_deploy_sha=""
  if [ "$frontend_required" = true ]; then
    frontend_ready=false
    if [ "$frontend_method" = "ambiguous" ]; then
      fetch_ok=false
    elif [ -n "$frontend_id" ]; then
      frontend_deploy_sha="$(latest_live_deploy_sha "$frontend_id")" || { frontend_deploy_sha=""; fetch_ok=false; }
      [ "$frontend_deploy_sha" = "$head_sha" ] && frontend_ready=true
    fi
  fi

  frontend_evidence_gap=true
  [ -n "$frontend_url" ] && frontend_evidence_gap=false

  healthz_ready=false
  if [ "$backend_ready" = true ] && healthz_ok "$backend_url"; then
    healthz_ready=true
  fi

  settled=false
  if [ "$migrations_touched" = false ] && [ "$backend_ready" = true ] && \
     [ "$frontend_ready" = true ] && [ "$ci_ready" = true ] && [ "$healthz_ready" = true ]; then
    settled=true
  fi

  jq -cn \
    --argjson pr "$pr" --arg headSha "$head_sha" \
    --argjson fetchOk "$fetch_ok" \
    --argjson migrationsTouched "$migrations_touched" \
    --argjson frontendTouched "$frontend_touched" \
    --argjson frontendRequired "$frontend_required" \
    --argjson isFreezePr "$is_freeze" \
    --arg ciSha "$ci_sha" \
    --argjson ciReady "$ci_ready" --argjson ciTotal "$ci_total" \
    --argjson ciPending "$ci_pending" --argjson ciFailed "$ci_failed" \
    --argjson ciSucceeded "$ci_succeeded" --argjson ciTruncated "$ci_truncated" \
    --arg backendPreviewId "$backend_id" --arg backendPreviewUrl "$backend_url" \
    --arg backendDeploySha "$backend_deploy_sha" --argjson backendReady "$backend_ready" \
    --arg frontendPreviewId "$frontend_id" --arg frontendPreviewUrl "$frontend_url" \
    --arg frontendDeploySha "$frontend_deploy_sha" --argjson frontendReady "$frontend_ready" \
    --argjson healthzReady "$healthz_ready" --argjson settled "$settled" \
    --argjson migrationFiles "$migration_files" --argjson migrationsDeterminable "$migrations_determinable" \
    --arg campaignSize "$campaign_size" --arg sizeReason "$campaign_size_reason" \
    --arg backendSelectionMethod "$backend_method" --argjson backendCandidates "$backend_candidates_json" \
    --arg frontendSelectionMethod "$frontend_method" --argjson frontendCandidates "$frontend_candidates_json" \
    --argjson previewAmbiguous "$preview_ambiguous" --arg previewAmbiguityReason "$preview_ambiguity_text" \
    --argjson frontendEvidenceGap "$frontend_evidence_gap" \
    '{
      pr: $pr, headSha: $headSha, fetchOk: $fetchOk,
      migrationsTouched: $migrationsTouched, frontendTouched: $frontendTouched,
      frontendRequired: $frontendRequired,
      campaignSize: $campaignSize, sizeReason: $sizeReason,
      migrationFiles: $migrationFiles, migrationsDeterminable: $migrationsDeterminable,
      isFreezePr: $isFreezePr, ciSha: (if $ciSha == "" then null else $ciSha end),
      ciReady: $ciReady, ciTotal: $ciTotal, ciPending: $ciPending,
      ciFailed: $ciFailed, ciSucceeded: $ciSucceeded, ciTruncated: $ciTruncated,
      backendPreviewId: (if $backendPreviewId == "" then null else $backendPreviewId end),
      backendPreviewUrl: (if $backendPreviewUrl == "" then null else $backendPreviewUrl end),
      backendDeploySha: (if $backendDeploySha == "" then null else $backendDeploySha end),
      backendReady: $backendReady,
      frontendPreviewId: (if $frontendPreviewId == "" then null else $frontendPreviewId end),
      frontendPreviewUrl: (if $frontendPreviewUrl == "" then null else $frontendPreviewUrl end),
      frontendDeploySha: (if $frontendDeploySha == "" then null else $frontendDeploySha end),
      frontendReady: $frontendReady,
      healthzReady: $healthzReady, settled: $settled,
      backendSelectionMethod: $backendSelectionMethod, backendCandidates: $backendCandidates,
      frontendSelectionMethod: $frontendSelectionMethod, frontendCandidates: $frontendCandidates,
      previewAmbiguous: $previewAmbiguous,
      previewAmbiguityReason: (if $previewAmbiguityReason == "" then null else $previewAmbiguityReason end),
      frontendEvidenceGap: $frontendEvidenceGap
    }'
}

detect_freeze() {
  local pr="$1" sha="$2" files_json is_freeze target_sha files_ok=true
  if ! files_json="$(timeout 10 gh api "repos/$REPO/pulls/$pr/files?per_page=100" 2>/dev/null)" ||
     ! jq -e 'type == "array"' <<<"$files_json" >/dev/null 2>&1; then
    files_ok=false
    files_json='[]'
  fi
  is_freeze="$(jq -r --arg a "$FREEZE_MARKER_BACKEND" --arg b "$FREEZE_MARKER_FRONTEND" '
    (length == 2) and ((map(.filename) | sort) == ([$a,$b] | sort))
  ' <<<"$files_json" 2>/dev/null)"
  [ "$is_freeze" = true ] || is_freeze=false
  target_sha=""
  if [ "$is_freeze" = true ]; then
    target_sha="$(timeout 8 gh api "repos/$REPO/commits/$sha" --jq '.parents[0].sha // empty' 2>/dev/null)"
  fi
  jq -cn --argjson isFreeze "$is_freeze" --argjson filesOk "$files_ok" --arg target "$target_sha" \
    '{isFreezePr:$isFreeze, filesOk:$filesOk,
      targetSha:(if $target == "" then null else $target end)}'
}

COMMAND="${1:-poll}"

if [ "$COMMAND" = "check" ]; then
  PR="${2:-}"
  if ! printf '%s' "$PR" | grep -Eq '^[1-9][0-9]*$'; then
    jq -cn '{ok:false,error:"check requires a PR number"}'
    exit 2
  fi
  MISSING=""
  [ -n "$REPO" ] || MISSING="$MISSING SMOKE_GATE_REPO"
  [ -n "$BACKEND_SERVICE" ] || MISSING="$MISSING SMOKE_GATE_BACKEND_SERVICE"
  [ -n "$FRONTEND_SERVICE" ] || MISSING="$MISSING SMOKE_GATE_FRONTEND_SERVICE"
MISSING="$MISSING$BAD_NUMERIC_CONFIG"
  if [ -n "$MISSING" ]; then
    jq -cn --argjson missing "$(printf '%s\n' $MISSING | jq -Rsc 'split("\n") | map(select(length > 0))')" \
      '{ok:false,error:"gate misconfigured",missing:$missing}'
    exit 2
  fi
  if ! PR_JSON="$(timeout 10 gh pr view "$PR" -R "$REPO" --json number,state,isDraft,headRefOid,headRefName,baseRefName,labels 2>/dev/null)" ||
     ! jq -e 'type == "object"' <<<"$PR_JSON" >/dev/null 2>&1; then
    jq -cn --argjson pr "$PR" '{ok:false,error:"failed to fetch PR",pr:$pr}'
    exit 1
  fi
  STATE_OK="$(jq -r '.state == "OPEN"' <<<"$PR_JSON")"
  BASE_OK="$(jq -r --arg b "$BRANCH" '.baseRefName == $b' <<<"$PR_JSON")"
  LABEL_OK="$(jq -r --arg l "$LABEL" '[.labels[].name] | index($l) != null' <<<"$PR_JSON")"
  if [ "$STATE_OK" != true ] || [ "$BASE_OK" != true ] || [ "$LABEL_OK" != true ]; then
    jq -cn --argjson pr "$PR" --argjson open "$STATE_OK" --argjson base "$BASE_OK" --argjson labeled "$LABEL_OK" \
      '{ok:true,pr:$pr,eligible:false,reason:(
        if $open != true then "pr not open"
        elif $base != true then "pr base does not match SMOKE_GATE_BRANCH"
        else "pr missing the smoke-gate label" end)}'
    exit 0
  fi
  HEAD_SHA="$(jq -r '.headRefOid' <<<"$PR_JSON")"
  HEAD_REF="$(jq -r '.headRefName // empty' <<<"$PR_JSON")"
  FACTS="$(evaluate_pr "$PR" "$HEAD_SHA" "$HEAD_REF")"
  FACTS="$(jq -c 'if .fetchOk != true then .settled = false else . end' <<<"$FACTS")"
  jq -cn --argjson facts "$FACTS" '{ok:true} + {eligible:true} + $facts'
  exit 0
fi

if [ "$COMMAND" = "claim" ]; then
  RUN_ID="${2:-}"
  PR="${3:-}"
  SHA="${4:-}"
  OWNER="${5:-$DEFAULT_OWNER}"
  if [ -z "$RUN_ID" ]; then
    jq -cn '{ok:false,error:"claim requires a run id"}'
    exit 2
  fi
  if ! run_id_ok "$RUN_ID"; then
    jq -cn --arg run "$RUN_ID" \
      '{ok:false,error:"run id must be 1-200 chars of [A-Za-z0-9._-] — it names files under the state dir",runId:$run}'
    exit 2
  fi
  if ! printf '%s' "$PR" | grep -Eq '^[1-9][0-9]*$'; then
    jq -cn '{ok:false,error:"claim requires a PR number"}'
    exit 2
  fi
  if ! printf '%s' "$SHA" | grep -Eq '^[0-9a-f]{40}$'; then
    jq -cn '{ok:false,error:"claim requires the 40-character frozen head SHA"}'
    exit 2
  fi
  exec 8>"$CONTROL_LOCK"
  if ! flock -w "$LOCK_WAIT" 8; then
    emit_lock_busy "$COMMAND" "$PR"
    exit 0
  fi
  OTHER_PR="$(find_pr_for_run "$RUN_ID" || true)"
  if [ -n "$OTHER_PR" ] && [ "$OTHER_PR" != "$PR" ]; then
    jq -cn --argjson pr "$PR" --argjson otherPr "$OTHER_PR" --arg run "$RUN_ID" \
      '{ok:false,error:"run id already claimed on a different PR — run ids must be unique across the gate",
        pr:$pr,runId:$run,activePr:$otherPr}'
    exit 0
  fi
  TASK_OTHER_FILE="$(task_state_file "$RUN_ID")"
  if [ -s "$TASK_OTHER_FILE" ]; then
    TASK_OTHER_WHY=""
    if ! TASK_OTHER_ACTIVE="$(jq -er '.activeRunId // ""' "$TASK_OTHER_FILE" 2>/dev/null)"; then
      TASK_OTHER_WHY="task-scoped state for this run id exists but cannot be read — refusing; run ids must be unique across the gate"
    elif [ "$TASK_OTHER_ACTIVE" = "$RUN_ID" ]; then
      TASK_OTHER_WHY="run id already claimed by an active task-scoped run (task-claim) — run ids must be unique across the gate"
    fi
    if [ -n "$TASK_OTHER_WHY" ]; then
      jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg err "$TASK_OTHER_WHY" --arg path "$TASK_OTHER_FILE" \
        '{ok:false,error:$err,pr:$pr,runId:$run,taskStateFile:$path}'
      exit 0
    fi
  fi
  exec 9>"$(pr_lock_file "$PR")"
  if ! flock -w "$LOCK_WAIT" 9; then
    emit_lock_busy "$COMMAND" "$PR"
    exit 0
  fi
  STATE="$(read_pr_state "$PR")"
  ACTIVE_RUN="$(jq -r '.activeRunId // empty' <<<"$STATE")"
  TOOK_OVER=""
  if [ -n "$ACTIVE_RUN" ] && [ "$ACTIVE_RUN" != "$RUN_ID" ] &&
     [ "$(active_run_is_live "$(jq -r '.activeStartedAt // empty' <<<"$STATE")" \
                             "$(jq -r '.activeProgressAt // empty' <<<"$STATE")")" = true ]; then
    ACTIVE_AGE="$(active_run_age "$(jq -r '.activeStartedAt // empty' <<<"$STATE")")"
    if [ "$TAKEOVER" = true ]; then
      TOOK_OVER="$ACTIVE_RUN"
    else
      if [ "$ACTIVE_AGE" -ge "$ACTIVE_STALE_SECONDS" ]; then
        HINT="active run has overrun ${ACTIVE_STALE_SECONDS}s and is still stamping progress — stop its coordinator, or re-run this claim with --takeover"
      else
        HINT="another run already owns this PR preview — wait for it or ask its coordinator"
      fi
      jq -cn --argjson pr "$PR" --arg active "$ACTIVE_RUN" --arg err "$HINT" \
        --argjson age "$ACTIVE_AGE" \
        --arg sha "$(jq -r '.activeSha // empty' <<<"$STATE")" \
        '{ok:false,error:$err,pr:$pr,activeRunId:$active,activeAgeSeconds:$age,
          activeSha:(if $sha == "" then null else $sha end)}'
      exit 0
    fi
  fi
  if [ "$TAKEOVER" != true ] &&
     [ "$(jq -r --arg sha "$SHA" \
          'if (.activeSha == $sha and .challengerDisposition == null and (.activeRunId // "") != "")
           then "true" else "false" end' <<<"$STATE")" = true ] &&
     [ "$(jq -r '.activeRunId // empty' <<<"$STATE")" != "$RUN_ID" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" \
      --arg active "$(jq -r '.activeRunId // empty' <<<"$STATE")" \
      --arg sha "$(jq -r '.activeSha // empty' <<<"$STATE")" \
      '{ok:false,
        error:"run id drift — this PR has an unfinished campaign on the same SHA; reclaim under its existing run id to continue it, or pass --takeover to deliberately start a new identity",
        pr:$pr,runId:$run,activeRunId:$active,
        activeSha:(if $sha == "" then null else $sha end)}'
    exit 0
  fi
  if ! lease_lifecycle_begin "$PR" "$RUN_ID" "$COMMAND"; then
    exit 0
  fi
  PRIOR_AUTHORITY="$(read_pr_authority "$PR")"
  AUTHORITY_STATUS="$(pr_authority_status "$PRIOR_AUTHORITY")"
  if [ "$AUTHORITY_STATUS" = malformed ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg path "$(pr_authority_file "$PR")" \
      '{ok:false,error:("shared PR authority is malformed at " + $path + " - refusing claim"),pr:$pr,runId:$run}'
    lease_lifecycle_end
    exit 0
  fi
  if [ "$AUTHORITY_STATUS" = live ] &&
     { [ "$(jq -r '.runId' <<<"$PRIOR_AUTHORITY")" != "$RUN_ID" ] ||
       [ "$(jq -r '.owner' <<<"$PRIOR_AUTHORITY")" != "$OWNER" ]; } &&
     [ "$TAKEOVER" != true ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg owner "$OWNER" --argjson authority "$PRIOR_AUTHORITY" \
      '{ok:false,error:"another live run owns this PR in the shared coordinator registry - refuse duplicate campaign unless an operator explicitly authorizes --takeover",pr:$pr,runId:$run,requestedBy:$owner,activeRunId:$authority.runId,leaseOwner:$authority.owner}'
    lease_lifecycle_end
    exit 0
  fi
  PRIOR_LEASE="$(read_lease "$RUN_ID")"
  if ! LEASE_RESULT="$(lease_acquire "$RUN_ID" "$OWNER" "$PR")"; then
    printf '%s\n' "$LEASE_RESULT"
    lease_lifecycle_end
    exit 0
  fi
  if ! bind_pr_authority "$PR" "$RUN_ID" "$OWNER"; then
    if [ "$(lease_is_live "$PRIOR_LEASE")" = true ]; then write_lease "$RUN_ID" "$PRIOR_LEASE" || true
    else rm -f "$(lease_file "$RUN_ID")" 2>/dev/null || true; fi
    lease_lifecycle_end
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" '{ok:false,error:"could not write shared PR authority - claim refused",pr:$pr,runId:$run}'
    exit 1
  fi
  if ! lease_fence_begin "$PR" "$RUN_ID" "$OWNER" "$COMMAND"; then
    exit 0
  fi
  NOW="$(iso_now)"
  STATE="$(jq -c --arg sha "$SHA" --arg now "$NOW" --arg run "$RUN_ID" --arg owner "$OWNER" --arg took "$TOOK_OVER" \
    --arg deadline "$(challenger_deadline_from_now)" \
    '(if (.activeSha == $sha and (.challengerDeadline // "") != "" and .challengerDisposition == null)
      then .challengerDeadline else $deadline end) as $dl |
     .activeSha=$sha | .activeStartedAt=$now | .activeRunId=$run | .activeProgressAt=$now |
     .activeLeaseOwner=$owner |
     .displacedRunId=(if $took == "" then null else $took end) |
     .displacedAt=(if $took == "" then null else $now end) |
     .challengerDeadline=$dl |
     .challengerDisposition=null | .challengerTimedOutAt=null |
     .finishIntent=null' <<<"$STATE")"
  if ! write_pr_state "$PR" "$STATE"; then
    CLEANUP=""
    if [ "$(lease_is_live "$PRIOR_LEASE")" = true ]; then
      write_lease "$RUN_ID" "$PRIOR_LEASE" || CLEANUP="; the preexisting shared lease also could not be restored"
    else
      lease_remove_fenced "$RUN_ID" || CLEANUP="; the just-acquired shared lease also could not be removed"
    fi
    if [ "$PRIOR_AUTHORITY" = null ]; then
      rm -f "$(pr_authority_file "$PR")" 2>/dev/null || CLEANUP="$CLEANUP; the new shared PR authority could not be removed"
    else
      write_pr_authority "$PR" "$PRIOR_AUTHORITY" || CLEANUP="$CLEANUP; the prior shared PR authority could not be restored"
    fi
    lease_fence_end
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg owner "$OWNER" --arg cleanup "$CLEANUP" \
      '{ok:false,error:("could not write the private PR slot - claim refused" + $cleanup),pr:$pr,runId:$run,owner:$owner}'
    exit 1
  fi
  lease_fence_end
  jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg sha "$SHA" --arg took "$TOOK_OVER" \
    --argjson lease "$(jq -c '.lease' <<<"$LEASE_RESULT")" \
    --arg deadline "$(jq -r '.challengerDeadline' <<<"$STATE")" \
    '{ok:true,runId:$run,pr:$pr,sha:$sha,
      tookOverFrom:(if $took == "" then null else $took end),
      lease:$lease,challengerDeadline:$deadline}'
  exit 0
fi

if [ "$COMMAND" = "lease-claim" ] || [ "$COMMAND" = "lease-renew" ] ||
   [ "$COMMAND" = "lease-release" ] || [ "$COMMAND" = "lease-status" ]; then
  RUN_ID="${2:-}"
  OWNER="${3:-$DEFAULT_OWNER}"
  if ! run_id_ok "$RUN_ID"; then
    jq -cn --arg cmd "$COMMAND" --arg run "$RUN_ID" \
      '{ok:false,error:($cmd + " requires a run id of 1-200 chars of [A-Za-z0-9._-]"),runId:$run}'
    exit 2
  fi

  if ! lease_dir_prepare; then
    emit_lease_dir_error "$RUN_ID" "$COMMAND"
    exit 1
  fi

  if [ "$COMMAND" = "lease-status" ]; then
    LEASE="$(read_lease "$RUN_ID")"
    if [ "$(lease_is_malformed "$LEASE")" = true ]; then
      jq -cn --arg run "$RUN_ID" --arg path "$(lease_file "$RUN_ID")" \
        '{ok:false,error:("shared coordinator lease is malformed at " + $path + " - refusing to report it available"),runId:$run,leaseFile:$path}'
      exit 1
    fi
    jq -cn --arg run "$RUN_ID" --argjson lease "$LEASE" --argjson live "$(lease_is_live "$LEASE")" \
      '{ok:true,runId:$run,held:$live,lease:$lease}'
    exit 0
  fi

  if [ "$COMMAND" = "lease-claim" ]; then
    LEASE_PR="${4:-}"
    if ! printf '%s' "$LEASE_PR" | grep -Eq '^[1-9][0-9]*$'; then
      EXISTING_LEASE="$(read_lease "$RUN_ID")"
      if [ "$(lease_is_malformed "$EXISTING_LEASE")" != true ] && [ "$EXISTING_LEASE" != null ] &&
         [ "$(jq -r '.owner // empty' <<<"$EXISTING_LEASE")" = "$OWNER" ]; then
        LEASE_PR="$(jq -r '.pr' <<<"$EXISTING_LEASE")"
      else
        jq -cn --arg run "$RUN_ID" \
          '{ok:false,error:"lease-claim requires the PR number for a new shared run id; use lease-claim <run-id> <owner-token> <pr>",runId:$run}'
        exit 2
      fi
    fi
    lease_acquire "$RUN_ID" "$OWNER" "$LEASE_PR"
    exit 0
  fi

  if ! exec 6>"$(lease_lock_file "$RUN_ID")"; then
    jq -cn --arg run "$RUN_ID" --arg cmd "$COMMAND" --arg dir "$LEASE_DIR" \
      '{ok:false,error:("could not open shared lease lock under " + $dir + " - refusing to continue unleased"),runId:$run,command:$cmd,leaseDir:$dir}'
    exit 1
  fi
  if ! flock -w "$LOCK_WAIT" 6; then
    jq -cn --arg run "$RUN_ID" --arg cmd "$COMMAND" \
      '{ok:false,retryable:true,
        error:"gate_lock_busy: another invocation held this run'"'"'s lease lock — RETRY this same command in ~10s.",
        runId:$run,command:$cmd}'
    exit 0
  fi
  LEASE="$(read_lease "$RUN_ID")"
  if [ "$(lease_is_malformed "$LEASE")" = true ]; then
    jq -cn --arg run "$RUN_ID" --arg cmd "$COMMAND" --arg path "$(lease_file "$RUN_ID")" \
      '{ok:false,error:("shared coordinator lease is malformed at " + $path + " - refusing to renew or release"),runId:$run,command:$cmd,leaseFile:$path}'
    flock -u 6
    exit 1
  fi
  if [ "$LEASE" = null ]; then
    jq -cn --arg run "$RUN_ID" --arg cmd "$COMMAND" \
      '{ok:false,error:("no lease exists for this run — " +
        (if $cmd == "lease-renew" then "claim it with lease-claim before renewing" else "nothing to release" end)),
        runId:$run}'
    flock -u 6
    exit 0
  fi
  LEASE_OWNER="$(jq -r '.owner // empty' <<<"$LEASE")"
  if [ "$LEASE_OWNER" != "$OWNER" ]; then
    jq -cn --arg run "$RUN_ID" --arg owner "$OWNER" --argjson lease "$LEASE" \
      --argjson live "$(lease_is_live "$LEASE")" \
      '{ok:false,error:"this run'"'"'s lease belongs to another owner — only its owner may renew or release it",
        runId:$run,requestedBy:$owner,leaseOwner:$lease.owner,held:$live,expiresAt:$lease.expiresAt}'
    flock -u 6
    exit 0
  fi
  if [ "$(lease_is_live "$LEASE")" != true ]; then
    jq -cn --arg run "$RUN_ID" --arg owner "$OWNER" --arg cmd "$COMMAND" --arg exp "$(jq -r '.expiresAt' <<<"$LEASE")" \
      '{ok:false,error:("the coordinator lease expired at " + $exp + " - " + $cmd + " cannot revive or remove expired authority; recover with claim using the same run id and owner token"),runId:$run,requestedBy:$owner,expiresAt:$exp}'
    flock -u 6
    exit 0
  fi
  if [ "$COMMAND" = "lease-release" ]; then
    if ! lease_remove_fenced "$RUN_ID"; then
      jq -cn --arg run "$RUN_ID" --arg owner "$OWNER" --arg dir "$LEASE_DIR" \
        '{ok:false,error:("could not remove shared lease under " + $dir + " - refusing to report it released"),runId:$run,owner:$owner,leaseDir:$dir}'
      flock -u 6
      exit 1
    fi
    jq -cn --arg run "$RUN_ID" --arg owner "$OWNER" '{ok:true,runId:$run,released:true,owner:$owner}'
    flock -u 6
    exit 0
  fi
  NEXT="$(jq -c --arg now "$(iso_now)" --arg exp "$(lease_expiry_from_now)" \
    '.renewedAt=$now | .expiresAt=$exp' <<<"$LEASE")"
  if ! write_lease "$RUN_ID" "$NEXT"; then
    jq -cn --arg run "$RUN_ID" --arg dir "$LEASE_DIR" \
      '{ok:false,error:("could not write the lease file under " + $dir + " - the lease will EXPIRE; fix the shared lease dir and retry"),runId:$run,leaseDir:$dir}'
    flock -u 6
    exit 1
  fi
  jq -cn --arg run "$RUN_ID" --argjson lease "$(read_lease "$RUN_ID")" \
    '{ok:true,runId:$run,renewed:true,lease:$lease}'
  flock -u 6
  exit 0
fi

if [ "$COMMAND" = "progress" ]; then
  RUN_ID="${2:-}"
  OWNER="${3:-$DEFAULT_OWNER}"
  PR="$(find_pr_for_run "$RUN_ID" || true)"
  if [ -z "$RUN_ID" ] || [ -z "${PR:-}" ]; then
    emit_not_active "$RUN_ID" "not the active run (reclaimed or finished) — stop this campaign"
    exit 0
  fi
  exec 9>"$(pr_lock_file "$PR")"
  if ! flock -w "$LOCK_WAIT" 9; then
    emit_lock_busy "$COMMAND" "$PR"
    exit 0
  fi
  STATE="$(read_pr_state "$PR")"
  ACTIVE_RUN="$(jq -r '.activeRunId // empty' <<<"$STATE")"
  if [ "$RUN_ID" != "$ACTIVE_RUN" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg active "$ACTIVE_RUN" \
      '{ok:false,error:"not the active run (reclaimed or finished) — stop this campaign",
        pr:$pr,runId:(if $run == "" then null else $run end),
        activeRunId:(if $active == "" then null else $active end)}'
    exit 0
  fi
  STORED_OWNER="$(jq -r '.activeLeaseOwner // empty' <<<"$STATE")"
  if [ -z "$STORED_OWNER" ] || [ "$OWNER" != "$STORED_OWNER" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg owner "$OWNER" --arg stored "$STORED_OWNER" \
      '{ok:false,error:"caller owner does not match the owner recorded by claim - STOP this campaign",pr:$pr,runId:$run,requestedBy:$owner,claimedBy:(if $stored == "" then null else $stored end)}'
    exit 0
  fi
  if ! lease_fence_begin "$PR" "$RUN_ID" "$OWNER" "$COMMAND"; then
    exit 0
  fi
  NOW="$(iso_now)"
  RENEWED_LEASE="$(jq -c --arg now "$NOW" --arg exp "$(lease_expiry_from_now)" \
    '.renewedAt=$now | .expiresAt=$exp' <<<"$FENCED_LEASE_JSON")"
  if ! write_lease "$RUN_ID" "$RENEWED_LEASE"; then
    lease_fence_end
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg dir "$LEASE_DIR" \
      '{ok:false,error:("could not renew the live shared lease under " + $dir + " - progress not recorded; retry before the lease expires"),pr:$pr,runId:$run}'
    exit 1
  fi
  STATE="$(jq -c --arg now "$NOW" '.activeProgressAt=$now' <<<"$STATE")"
  if ! write_pr_state "$PR" "$STATE"; then
    lease_fence_end
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" \
      '{ok:false,error:"could not write progress state - progress not recorded",pr:$pr,runId:$run}'
    exit 1
  fi
  lease_fence_end
  jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --argjson lease "$RENEWED_LEASE" \
    '{ok:true,runId:$run,pr:$pr,leaseRenewed:true,lease:$lease}'
  exit 0
fi

if [ "$COMMAND" = "release" ]; then
  RUN_ID="${2:-}"
  OWNER="${3:-$DEFAULT_OWNER}"
  PR="$(find_pr_for_run "$RUN_ID" || true)"
  if [ -z "$RUN_ID" ] || [ -z "${PR:-}" ]; then
    emit_not_active "$RUN_ID" "not the active run — nothing released"
    exit 0
  fi
  exec 9>"$(pr_lock_file "$PR")"
  if ! flock -w "$LOCK_WAIT" 9; then
    emit_lock_busy "$COMMAND" "$PR"
    exit 0
  fi
  STATE="$(read_pr_state "$PR")"
  ACTIVE_RUN="$(jq -r '.activeRunId // empty' <<<"$STATE")"
  if [ "$RUN_ID" != "$ACTIVE_RUN" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg active "$ACTIVE_RUN" \
      '{ok:false,error:"not the active run — nothing released",
        pr:$pr,runId:(if $run == "" then null else $run end),
        activeRunId:(if $active == "" then null else $active end)}'
    exit 0
  fi
  STORED_OWNER="$(jq -r '.activeLeaseOwner // empty' <<<"$STATE")"
  if [ -z "$STORED_OWNER" ] || [ "$OWNER" != "$STORED_OWNER" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg owner "$OWNER" --arg stored "$STORED_OWNER" \
      '{ok:false,error:"caller owner does not match the owner recorded by claim - nothing released",pr:$pr,runId:$run,requestedBy:$owner,claimedBy:(if $stored == "" then null else $stored end)}'
    exit 0
  fi
  if ! lease_fence_begin "$PR" "$RUN_ID" "$OWNER" "$COMMAND"; then
    exit 0
  fi
  STATE="$(jq -c '.activeSha=null | .activeStartedAt=null | .activeRunId=null | .activeProgressAt=null |
     .activeLeaseOwner=null | .challengerDeadline=null | .finishIntent=null' <<<"$STATE")"
  if ! remove_pr_authority_fenced "$PR" "$RUN_ID" "$OWNER"; then
    lease_fence_end
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" \
      '{ok:false,error:"could not remove matching shared PR authority - nothing released",pr:$pr,runId:$run,leaseReleased:false}'
    exit 1
  fi
  if ! lease_remove_fenced "$RUN_ID"; then
    write_pr_authority "$PR" "$FENCED_AUTHORITY_JSON" || true
    lease_fence_end
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg dir "$LEASE_DIR" \
      '{ok:false,error:("could not remove the shared lease under " + $dir + " - nothing released"),pr:$pr,runId:$run,leaseReleased:false}'
    exit 1
  fi
  if ! write_pr_state "$PR" "$STATE"; then
    RESTORED=false
    if lease_restore_fenced "$RUN_ID" "$FENCED_LEASE_JSON" &&
       write_pr_authority "$PR" "$FENCED_AUTHORITY_JSON"; then RESTORED=true; fi
    lease_fence_end
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --argjson restored "$RESTORED" \
      '{ok:false,error:"could not write released PR state - release refused and lease restoration attempted",pr:$pr,runId:$run,leaseReleased:false,leaseRestored:$restored}'
    exit 1
  fi
  lease_fence_end
  jq -cn --argjson pr "$PR" --arg run "$RUN_ID" '{ok:true,releasedRunId:$run,pr:$pr,leaseReleased:true}'
  exit 0
fi

if [ "$COMMAND" = "task-claim" ]; then
  RUN_ID="${2:-}"
  SHA="${3:-}"
  OWNER="${4:-$DEFAULT_OWNER}"
  if [ -z "$RUN_ID" ]; then
    jq -cn '{ok:false,error:"task-claim requires a run id"}'
    exit 2
  fi
  if ! run_id_ok "$RUN_ID"; then
    jq -cn --arg run "$RUN_ID" \
      '{ok:false,error:"run id must be 1-200 chars of [A-Za-z0-9._-] — it names files under the state dir",runId:$run}'
    exit 2
  fi
  if ! printf '%s' "$SHA" | grep -Eq '^[0-9a-f]{40}$'; then
    jq -cn '{ok:false,error:"task-claim requires the 40-character frozen deploy SHA"}'
    exit 2
  fi
  if ! exec 8>"$CONTROL_LOCK"; then
    jq -cn --arg run "$RUN_ID" --arg lock "$CONTROL_LOCK" \
      '{ok:false,error:("could not open the gate control lock at " + $lock + " - task-claim refused"),runId:$run}'
    exit 1
  fi
  if ! flock -w "$LOCK_WAIT" 8; then
    emit_lock_busy "$COMMAND"
    exit 0
  fi
  OTHER_PR="$(find_pr_for_any_run "$RUN_ID" || true)"
  if [ -n "$OTHER_PR" ]; then
    jq -cn --arg run "$RUN_ID" --argjson otherPr "$OTHER_PR" \
      '{ok:false,error:"run id already claimed by a PR campaign — run ids must be unique across the gate",runId:$run,activePr:$otherPr}'
    exit 0
  fi
  if [ -e "$STATE_DIR/develop-state.json" ] &&
     [ "$(jq -r '.activeRunId // empty' "$STATE_DIR/develop-state.json" 2>/dev/null)" = "$RUN_ID" ]; then
    jq -cn --arg run "$RUN_ID" \
      '{ok:false,error:"run id already claimed by the develop campaign — run ids must be unique across the gate",runId:$run}'
    exit 0
  fi
  if ! task_lease_acquire "$RUN_ID" "$OWNER" "$SHA"; then
    exit 0
  fi
  NOW="$(iso_now)"
  STATE="$(jq -cn --arg run "$RUN_ID" --arg sha "$SHA" --arg now "$NOW" --arg owner "$OWNER" \
    '{schemaVersion:1,activeRunId:$run,activeSha:$sha,activeStartedAt:$now,activeProgressAt:$now,
      activeLeaseOwner:$owner,completedAt:null,completedRunId:null,completedVerdict:null}')"
  if ! (mkdir -p "$STATE_DIR" 2>/dev/null; tmp="$(mktemp "$STATE_DIR/.task-$RUN_ID-state.XXXXXX" 2>/dev/null)" &&
        printf '%s\n' "$STATE" > "$tmp" 2>/dev/null && mv "$tmp" "$(task_state_file "$RUN_ID")" 2>/dev/null); then
    CLEANUP=""
    if [ "$TASK_PRIOR_LEASE_JSON" = null ]; then
      task_lease_remove_fenced "$RUN_ID" || CLEANUP="; the just-acquired shared task lease also could not be removed"
    else
      write_task_lease "$RUN_ID" "$TASK_PRIOR_LEASE_JSON" || CLEANUP="; the preexisting shared task lease also could not be restored"
    fi
    task_lease_fence_end
    jq -cn --arg run "$RUN_ID" --arg owner "$OWNER" --arg cleanup "$CLEANUP" \
      '{ok:false,error:("could not write the private task slot - claim refused" + $cleanup),runId:$run,owner:$owner}'
    exit 1
  fi
  task_lease_fence_end
  jq -cn --arg run "$RUN_ID" --arg sha "$SHA" --argjson lease "$TASK_ACQUIRED_LEASE_JSON" \
    '{ok:true,runId:$run,sha:$sha,lease:$lease}'
  exit 0
fi

if [ "$COMMAND" = "task-progress" ]; then
  RUN_ID="${2:-}"
  OWNER="${3:-$DEFAULT_OWNER}"
  TASK_STATE_FILE="$(task_state_file "$RUN_ID")"
  if [ -z "$RUN_ID" ] || [ ! -s "$TASK_STATE_FILE" ] ||
     [ "$(jq -r '.activeRunId // empty' "$TASK_STATE_FILE" 2>/dev/null)" != "$RUN_ID" ]; then
    emit_not_active "$RUN_ID" "not the active task run (reclaimed or finished) — stop this run"
    exit 0
  fi
  STATE="$(jq -c '.' "$TASK_STATE_FILE")"
  STORED_OWNER="$(jq -r '.activeLeaseOwner // empty' <<<"$STATE")"
  if [ -z "$STORED_OWNER" ] || [ "$OWNER" != "$STORED_OWNER" ]; then
    jq -cn --arg run "$RUN_ID" --arg owner "$OWNER" --arg stored "$STORED_OWNER" \
      '{ok:false,error:"caller owner does not match the owner recorded by task-claim - STOP this run",runId:$run,requestedBy:$owner,claimedBy:(if $stored == "" then null else $stored end)}'
    exit 0
  fi
  if ! task_lease_fence_begin "$RUN_ID" "$OWNER" "$COMMAND"; then
    exit 0
  fi
  NOW="$(iso_now)"
  RENEWED_LEASE="$(jq -c --arg now "$NOW" --arg exp "$(lease_expiry_from_now)" \
    '.renewedAt=$now | .expiresAt=$exp' <<<"$FENCED_TASK_LEASE_JSON")"
  if ! write_task_lease "$RUN_ID" "$RENEWED_LEASE"; then
    task_lease_fence_end
    jq -cn --arg run "$RUN_ID" --arg dir "$LEASE_DIR" \
      '{ok:false,error:("could not renew the live shared task lease under " + $dir + " - progress not recorded; retry before the lease expires"),runId:$run}'
    exit 1
  fi
  STATE="$(jq -c --arg now "$NOW" '.activeProgressAt=$now' <<<"$STATE")"
  tmp="$(mktemp "$STATE_DIR/.task-$RUN_ID-state.XXXXXX" 2>/dev/null)"
  if [ -z "$tmp" ] || ! printf '%s\n' "$STATE" > "$tmp" 2>/dev/null || ! mv "$tmp" "$TASK_STATE_FILE" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null || true
    task_lease_fence_end
    jq -cn --arg run "$RUN_ID" '{ok:false,error:"could not write progress state - progress not recorded",runId:$run}'
    exit 1
  fi
  task_lease_fence_end
  jq -cn --arg run "$RUN_ID" --argjson lease "$RENEWED_LEASE" '{ok:true,runId:$run,leaseRenewed:true,lease:$lease}'
  exit 0
fi

if [ "$COMMAND" = "task-release" ]; then
  RUN_ID="${2:-}"
  OWNER="${3:-$DEFAULT_OWNER}"
  TASK_STATE_FILE="$(task_state_file "$RUN_ID")"
  if [ -z "$RUN_ID" ] || [ ! -s "$TASK_STATE_FILE" ] ||
     [ "$(jq -r '.activeRunId // empty' "$TASK_STATE_FILE" 2>/dev/null)" != "$RUN_ID" ]; then
    emit_not_active "$RUN_ID" "not the active task run — nothing released"
    exit 0
  fi
  STATE="$(jq -c '.' "$TASK_STATE_FILE")"
  STORED_OWNER="$(jq -r '.activeLeaseOwner // empty' <<<"$STATE")"
  if [ -z "$STORED_OWNER" ] || [ "$OWNER" != "$STORED_OWNER" ]; then
    jq -cn --arg run "$RUN_ID" --arg owner "$OWNER" --arg stored "$STORED_OWNER" \
      '{ok:false,error:"caller owner does not match the owner recorded by task-claim - nothing released",runId:$run,requestedBy:$owner,claimedBy:(if $stored == "" then null else $stored end)}'
    exit 0
  fi
  if ! task_lease_fence_begin "$RUN_ID" "$OWNER" "$COMMAND"; then
    exit 0
  fi
  STATE="$(jq -c '.activeSha=null | .activeStartedAt=null | .activeRunId=null | .activeProgressAt=null |
     .activeLeaseOwner=null' <<<"$STATE")"
  if ! task_lease_remove_fenced "$RUN_ID"; then
    task_lease_fence_end
    jq -cn --arg run "$RUN_ID" --arg dir "$LEASE_DIR" \
      '{ok:false,error:("could not remove the shared task lease under " + $dir + " - nothing released"),runId:$run,leaseReleased:false}'
    exit 1
  fi
  tmp="$(mktemp "$STATE_DIR/.task-$RUN_ID-state.XXXXXX" 2>/dev/null)"
  if [ -z "$tmp" ] || ! printf '%s\n' "$STATE" > "$tmp" 2>/dev/null || ! mv "$tmp" "$TASK_STATE_FILE" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null || true
    RESTORED=false
    write_task_lease "$RUN_ID" "$FENCED_TASK_LEASE_JSON" && RESTORED=true
    task_lease_fence_end
    jq -cn --arg run "$RUN_ID" --argjson restored "$RESTORED" \
      '{ok:false,error:"could not write released task state - release refused and lease restoration attempted",runId:$run,leaseReleased:false,leaseRestored:$restored}'
    exit 1
  fi
  task_lease_fence_end
  jq -cn --arg run "$RUN_ID" '{ok:true,releasedRunId:$run,leaseReleased:true}'
  exit 0
fi

if [ "$COMMAND" = "task-finish" ]; then
  RUN_ID="${2:-}"
  SHA="${3:-}"
  VERDICT="${4:-}"
  OWNER="${5:-$DEFAULT_OWNER}"
  if ! run_id_ok "$RUN_ID"; then
    jq -cn --arg run "$RUN_ID" \
      '{ok:false,error:"task-finish requires a run id of 1-200 chars of [A-Za-z0-9._-]",runId:$run}'
    exit 2
  fi
  if ! printf '%s' "$SHA" | grep -Eq '^[0-9a-f]{40}$'; then
    jq -cn '{ok:false,error:"task-finish requires the 40-character deploy SHA this run claimed"}'
    exit 2
  fi
  case "$VERDICT" in
    GO|NO_GO|HUMAN_DECISION|BLOCKED) ;;
    *) jq -cn '{ok:false,error:"task-finish verdict must be GO, NO_GO, HUMAN_DECISION, or BLOCKED"}'; exit 2 ;;
  esac

  RUN_VERDICT_FILE="$(run_verdict_file "$RUN_ID")"
  RUN_VERDICT_RESUMED=false
  TASK_STATE_FILE="$(task_state_file "$RUN_ID")"
  if [ -s "$RUN_VERDICT_FILE" ]; then
    EXISTING_VERDICT="$(jq -c '.' "$RUN_VERDICT_FILE" 2>/dev/null || printf '')"
    if [ -n "$EXISTING_VERDICT" ] &&
       jq -e --arg sha "$SHA" --arg run "$RUN_ID" --arg v "$VERDICT" \
         '.sha == $sha and .runId == $run and .verdict == $v' \
         <<<"$EXISTING_VERDICT" >/dev/null 2>&1; then
      NOW="$(jq -r '.finishedAt' <<<"$EXISTING_VERDICT")"
      VERDICT_DIGEST="$(verdict_digest "$EXISTING_VERDICT")"
      RUN_VERDICT_RESUMED=true
      if [ -s "$TASK_STATE_FILE" ] &&
         [ "$(jq -r '.completedRunId // empty' "$TASK_STATE_FILE" 2>/dev/null)" = "$RUN_ID" ]; then
        jq -cn --argjson verdict "$EXISTING_VERDICT" --arg digest "$VERDICT_DIGEST" \
          '{ok:true,idempotent:true,
            note:"this run was already finished with these exact terminal facts — nothing re-recorded, no artifact rewritten",
            verdictDigest:$digest} + $verdict'
        exit 0
      fi
    else
      jq -cn --arg run "$RUN_ID" --arg path "$RUN_VERDICT_FILE" --arg sha "$SHA" --arg attempted "$VERDICT" \
        --argjson recorded "$(if [ -n "$EXISTING_VERDICT" ]; then printf '%s' "$EXISTING_VERDICT"; else printf '"unparseable"'; fi)" \
        '{ok:false,gateStatus:"reconciliation_required",
          error:("a DIFFERENT verdict is already recorded for this run — STOP. Nothing was overwritten and no verdict was fabricated. " +
                 $path + " stays canonical; a human must reconcile which run owns this outcome before any verdict is published."),
          runId:$run,runVerdictFile:$path,recordedVerdict:$recorded,attemptedVerdict:{sha:$sha,verdict:$attempted}}'
      exit 1
    fi
  fi

  if [ ! -s "$TASK_STATE_FILE" ] ||
     [ "$(jq -r '.activeRunId // empty' "$TASK_STATE_FILE" 2>/dev/null)" != "$RUN_ID" ]; then
    emit_not_active "$RUN_ID" "not the active task run (reclaimed or already finished) — no verdict recorded"
    exit 0
  fi
  STATE="$(jq -c '.' "$TASK_STATE_FILE")"
  CLAIMED_SHA="$(jq -r '.activeSha // empty' <<<"$STATE")"
  if [ "$SHA" != "$CLAIMED_SHA" ]; then
    jq -cn --arg run "$RUN_ID" --arg supplied "$SHA" --arg claimed "$CLAIMED_SHA" \
      '{ok:false,
        error:("task-finish sha does not match the deploy sha this run claimed — no verdict recorded, slot still held. Re-run: task-finish " +
               $run + " " + (if $claimed == "" then "<claimed-sha>" else $claimed end) + " <verdict>"),
        runId:$run,suppliedSha:$supplied,claimedSha:(if $claimed == "" then null else $claimed end)}'
    exit 2
  fi
  STORED_OWNER="$(jq -r '.activeLeaseOwner // empty' <<<"$STATE")"
  if [ -z "$STORED_OWNER" ] || [ "$OWNER" != "$STORED_OWNER" ]; then
    jq -cn --arg run "$RUN_ID" --arg owner "$OWNER" --arg stored "$STORED_OWNER" \
      '{ok:false,error:"caller owner does not match the owner recorded by task-claim - no terminal effect attempted",runId:$run,requestedBy:$owner,claimedBy:(if $stored == "" then null else $stored end)}'
    exit 0
  fi
  if ! task_lease_fence_begin "$RUN_ID" "$OWNER" "$COMMAND"; then
    exit 0
  fi

  if [ "$RUN_VERDICT_RESUMED" != true ]; then
    NOW="$(iso_now)"
    VERDICT_DIGEST="$(verdict_digest "$(verdict_payload "$SHA" "$RUN_ID" "$VERDICT" "$NOW")")"
    mkdir -p "$(run_dir "$RUN_ID")" 2>/dev/null
    RV_TMP="$(mktemp "$(run_dir "$RUN_ID")/.verdict.XXXXXX" 2>/dev/null)"
    if [ -z "$RV_TMP" ]; then
      task_lease_fence_end
      jq -cn --arg run "$RUN_ID" --arg dir "$(run_dir "$RUN_ID")" \
        '{ok:false,error:("could not stage the run verdict under " + $dir +
                          " — no verdict recorded, slot still held. Fix the state dir and re-run this task-finish."),runId:$run}'
      exit 1
    fi
    verdict_payload "$SHA" "$RUN_ID" "$VERDICT" "$NOW" > "$RV_TMP"
    if ln "$RV_TMP" "$RUN_VERDICT_FILE" 2>/dev/null; then
      rm -f "$RV_TMP" 2>/dev/null
    else
      rm -f "$RV_TMP" 2>/dev/null
      EXISTING_VERDICT="$(jq -c '.' "$RUN_VERDICT_FILE" 2>/dev/null || printf '')"
      if [ -n "$EXISTING_VERDICT" ] && [ "$(verdict_digest "$EXISTING_VERDICT")" = "$VERDICT_DIGEST" ]; then
        : # identical file already there — proceed, the state clear below is idempotent
      else
        task_lease_fence_end
        jq -cn --arg run "$RUN_ID" --arg path "$RUN_VERDICT_FILE" --arg sha "$SHA" --arg attempted "$VERDICT" \
          --argjson recorded "$(if [ -n "$EXISTING_VERDICT" ]; then printf '%s' "$EXISTING_VERDICT"; else printf '"unparseable"'; fi)" \
          '{ok:false,gateStatus:"reconciliation_required",
            error:("a DIFFERENT verdict was written for this run while this task-finish was running — STOP. Nothing was overwritten and no verdict was fabricated; " +
                   $path + " stays canonical. A human must reconcile which run owns this outcome."),
            runId:$run,runVerdictFile:$path,recordedVerdict:$recorded,attemptedVerdict:{sha:$sha,verdict:$attempted}}'
        exit 1
      fi
    fi
  fi

  if ! task_lease_remove_fenced "$RUN_ID"; then
    task_lease_fence_end
    jq -cn --arg run "$RUN_ID" --arg dir "$LEASE_DIR" \
      '{ok:false,error:("could not remove the shared task lease under " + $dir + " - terminal state not committed"),runId:$run,leaseReleased:false}'
    exit 1
  fi
  STATE="$(jq -c --arg sha "$SHA" --arg run "$RUN_ID" --arg verdict "$VERDICT" --arg now "$NOW" \
    '.completedSha=$sha | .completedAt=$now | .completedRunId=$run | .completedVerdict=$verdict |
     .activeSha=null | .activeStartedAt=null | .activeRunId=null | .activeProgressAt=null | .activeLeaseOwner=null' <<<"$STATE")"
  tmp="$(mktemp "$STATE_DIR/.task-$RUN_ID-state.XXXXXX" 2>/dev/null)"
  if [ -z "$tmp" ] || ! printf '%s\n' "$STATE" > "$tmp" 2>/dev/null || ! mv "$tmp" "$TASK_STATE_FILE" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null || true
    RESTORED=false
    write_task_lease "$RUN_ID" "$FENCED_TASK_LEASE_JSON" && RESTORED=true
    task_lease_fence_end
    jq -cn --arg run "$RUN_ID" --argjson restored "$RESTORED" \
      '{ok:false,error:"could not commit terminal task state - no success receipt returned and lease restoration attempted",runId:$run,leaseReleased:false,leaseRestored:$restored}'
    exit 1
  fi
  task_lease_fence_end
  jq -cn --arg run "$RUN_ID" --arg sha "$SHA" --arg verdict "$VERDICT" --arg now "$NOW" --arg digest "$VERDICT_DIGEST" \
    '{ok:true,leaseReleased:true,runId:$run,sha:$sha,verdict:$verdict,finishedAt:$now,verdictDigest:$digest}'
  exit 0
fi

if [ "$COMMAND" = "finish" ]; then
  SHA="${2:-}"
  RUN_ID="${3:-}"
  VERDICT="${4:-}"
  OWNER="${5:-$DEFAULT_OWNER}"
  if ! printf '%s' "$SHA" | grep -Eq '^[0-9a-f]{40}$'; then
    jq -cn '{ok:false,error:"finish requires a 40-character SHA"}'
    exit 2
  fi
  case "$VERDICT" in
    GO|NO_GO|HUMAN_DECISION|BLOCKED) ;;
    *) jq -cn '{ok:false,error:"finish verdict must be GO, NO_GO, HUMAN_DECISION, or BLOCKED"}'; exit 2 ;;
  esac
  if ! run_id_ok "$RUN_ID"; then
    jq -cn --arg run "$RUN_ID" \
      '{ok:false,error:"finish requires a run id of 1-200 chars of [A-Za-z0-9._-]",runId:$run}'
    exit 2
  fi

  RUN_VERDICT_FILE="$(run_verdict_file "$RUN_ID")"
  RUN_VERDICT_RESUMED=false
  if [ -s "$RUN_VERDICT_FILE" ]; then
    EXISTING_VERDICT="$(jq -c '.' "$RUN_VERDICT_FILE" 2>/dev/null || printf '')"
    if [ -n "$EXISTING_VERDICT" ] &&
       jq -e --arg sha "$SHA" --arg run "$RUN_ID" --arg v "$VERDICT" \
         '.sha == $sha and .runId == $run and .verdict == $v' \
         <<<"$EXISTING_VERDICT" >/dev/null 2>&1; then
      NOW="$(jq -r '.finishedAt' <<<"$EXISTING_VERDICT")"
      VERDICT_DIGEST="$(verdict_digest "$EXISTING_VERDICT")"
      RUN_VERDICT_RESUMED=true
      COMPLETED_PR="$(find_pr_for_any_run "$RUN_ID" || true)"
      if [ -n "${COMPLETED_PR:-}" ] &&
         [ "$(jq -r '.completedRunId // empty' "$(pr_state_file "$COMPLETED_PR")" 2>/dev/null)" = "$RUN_ID" ]; then
        jq -cn --argjson pr "$COMPLETED_PR" --argjson verdict "$EXISTING_VERDICT" \
          --arg digest "$VERDICT_DIGEST" --arg path "$RUN_VERDICT_FILE" \
          '{ok:true,idempotent:true,
            note:"this run was already finished with these exact terminal facts — nothing re-recorded, no artifact rewritten",
            pr:$pr,verdictDigest:$digest,runVerdictFile:$path} + $verdict'
        exit 0
      fi
    else
      RECON_PR="$(find_pr_for_any_run "$RUN_ID" || true)"
      RECON_RECORDED=false
      jq -cn --arg run "$RUN_ID" --arg path "$RUN_VERDICT_FILE" --arg sha "$SHA" \
        --arg attempted "$VERDICT" --argjson recon "$RECON_RECORDED" \
        --argjson pr "$(if [ -n "${RECON_PR:-}" ]; then printf '%s' "$RECON_PR"; else printf 'null'; fi)" \
        --argjson recorded "$(if [ -n "$EXISTING_VERDICT" ]; then printf '%s' "$EXISTING_VERDICT"; else printf '"unparseable"'; fi)" \
        '{ok:false,gateStatus:"reconciliation_required",
          error:("a DIFFERENT verdict is already recorded for this run — STOP. Nothing was overwritten and no verdict was fabricated. " +
                 $path + " stays canonical; a human must reconcile which campaign owns this run before any verdict is published."),
          runId:$run,pr:$pr,runVerdictFile:$path,
          recordedVerdict:$recorded,attemptedVerdict:{sha:$sha,verdict:$attempted},
          stateFlagged:$recon}'
      exit 1
    fi
  fi

  PR="$(find_pr_for_run "$RUN_ID" || true)"
  if [ -z "$RUN_ID" ] || [ -z "${PR:-}" ]; then
    emit_not_active "$RUN_ID" "not the active run (reclaimed or already finished) — no verdict recorded"
    exit 0
  fi
  exec 9>"$(pr_lock_file "$PR")"
  if ! flock -w "$LOCK_WAIT" 9; then
    emit_lock_busy "$COMMAND" "$PR"
    exit 0
  fi
  STATE="$(read_pr_state "$PR")"
  ACTIVE_RUN="$(jq -r '.activeRunId // empty' <<<"$STATE")"
  if [ "$RUN_ID" != "$ACTIVE_RUN" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg active "$ACTIVE_RUN" \
      '{ok:false,error:"not the active run (reclaimed or already finished) — no verdict recorded, no hold touched",
        pr:$pr,runId:(if $run == "" then null else $run end),
        activeRunId:(if $active == "" then null else $active end)}'
    exit 0
  fi
  CLAIMED_SHA="$(jq -r '.activeSha // empty' <<<"$STATE")"
  if [ "$SHA" != "$CLAIMED_SHA" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg supplied "$SHA" --arg claimed "$CLAIMED_SHA" \
      '{ok:false,
        error:("finish sha does not match the sha this run claimed — no verdict recorded, no hold touched, slot still held. Re-run: finish " +
               (if $claimed == "" then "<claimed-sha>" else $claimed end) + " " + $run + " <verdict>"),
        pr:$pr,runId:$run,suppliedSha:$supplied,
        claimedSha:(if $claimed == "" then null else $claimed end)}'
    exit 2
  fi

  if [ "$VERDICT" = GO ] &&
     [ "$(jq -r '.challengerDisposition // empty' <<<"$STATE")" = "no-disposition" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" \
      --arg at "$(jq -r '.challengerTimedOutAt // empty' <<<"$STATE")" \
      '{ok:false,
        error:("this run'"'"'s challenger never filed a disposition before its deadline (recorded no-disposition at " + $at +
               ") — GO is REFUSED. An unchallenged campaign cannot pass. Finish NO_GO, HUMAN_DECISION or BLOCKED."),
        pr:$pr,runId:$run,challengerDisposition:"no-disposition",refusedVerdict:"GO"}'
    exit 2
  fi

  STORED_OWNER="$(jq -r '.activeLeaseOwner // empty' <<<"$STATE")"
  if [ -z "$STORED_OWNER" ] || [ "$OWNER" != "$STORED_OWNER" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg owner "$OWNER" --arg stored "$STORED_OWNER" \
      '{ok:false,error:"caller owner does not match the owner recorded by claim - no terminal effect attempted",pr:$pr,runId:$run,requestedBy:$owner,claimedBy:(if $stored == "" then null else $stored end)}'
    exit 0
  fi
  if ! lease_fence_begin "$PR" "$RUN_ID" "$OWNER" "$COMMAND"; then
    exit 0
  fi

  if [ "$RUN_VERDICT_RESUMED" != true ]; then
    INTENT="$(jq -c --arg run "$RUN_ID" --arg sha "$SHA" --arg v "$VERDICT" \
      '.finishIntent // empty | select(.runId == $run and .sha == $sha and .verdict == $v)' <<<"$STATE")"
    if [ -n "$INTENT" ]; then
      NOW="$(jq -r '.finishedAt' <<<"$INTENT")"
      VERDICT_DIGEST="$(jq -r '.digest' <<<"$INTENT")"
    else
      NOW="$(iso_now)"
      VERDICT_DIGEST="$(verdict_digest "$(verdict_payload "$SHA" "$RUN_ID" "$VERDICT" "$NOW")")"
      STATE="$(jq -c --arg run "$RUN_ID" --arg sha "$SHA" --arg v "$VERDICT" \
        --arg now "$NOW" --arg d "$VERDICT_DIGEST" \
        '.finishIntent={runId:$run,sha:$sha,verdict:$v,finishedAt:$now,digest:$d,recordedAt:$now}' <<<"$STATE")"
      write_pr_state "$PR" "$STATE"
    fi

    mkdir -p "$(run_dir "$RUN_ID")" 2>/dev/null
    RV_TMP="$(mktemp "$(run_dir "$RUN_ID")/.verdict.XXXXXX" 2>/dev/null)"
    if [ -z "$RV_TMP" ]; then
      jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg dir "$(run_dir "$RUN_ID")" \
        '{ok:false,error:("could not stage the run verdict under " + $dir +
                          " — no verdict recorded, no hold touched, slot still held. Fix the state dir and re-run this finish."),
          pr:$pr,runId:$run}'
      exit 1
    fi
    verdict_payload "$SHA" "$RUN_ID" "$VERDICT" "$NOW" > "$RV_TMP"
    if ln "$RV_TMP" "$RUN_VERDICT_FILE" 2>/dev/null; then
      rm -f "$RV_TMP" 2>/dev/null
    else
      rm -f "$RV_TMP" 2>/dev/null
      EXISTING_VERDICT="$(jq -c '.' "$RUN_VERDICT_FILE" 2>/dev/null || printf '')"
      if [ -n "$EXISTING_VERDICT" ] &&
         [ "$(verdict_digest "$EXISTING_VERDICT")" = "$VERDICT_DIGEST" ]; then
        : # identical file already there — proceed, the artifacts below are idempotent
      else
        STATE="$(jq -c --arg now "$(iso_now)" --arg run "$RUN_ID" --arg path "$RUN_VERDICT_FILE" \
          --arg attempted "$VERDICT" --arg sha "$SHA" \
          --argjson recorded "$(if [ -n "$EXISTING_VERDICT" ]; then printf '%s' "$EXISTING_VERDICT"; else printf '"unparseable"'; fi)" \
          '.gateStatus="reconciliation_required" |
           .reconciliation={detectedAt:$now,runId:$run,verdictFile:$path,
                            recorded:$recorded,attempted:{sha:$sha,verdict:$attempted}}' <<<"$STATE")"
        RECON_RECORDED=false
        if write_pr_state "$PR" "$STATE"; then RECON_RECORDED=true; fi
        jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg path "$RUN_VERDICT_FILE" \
          --arg sha "$SHA" --arg attempted "$VERDICT" \
          --argjson recon "$RECON_RECORDED" \
          --argjson recorded "$(if [ -n "$EXISTING_VERDICT" ]; then printf '%s' "$EXISTING_VERDICT"; else printf '"unparseable"'; fi)" \
          '{ok:false,gateStatus:"reconciliation_required",
            error:("a DIFFERENT verdict was written for this run while this finish was running — STOP. Nothing was overwritten and no verdict was fabricated; " +
                   $path + " stays canonical. A human must reconcile which campaign owns this run."),
            pr:$pr,runId:$run,runVerdictFile:$path,
            recordedVerdict:$recorded,attemptedVerdict:{sha:$sha,verdict:$attempted},stateFlagged:$recon}'
        exit 1
      fi
    fi
  fi

  SUSPEND_ATTEMPTED=false
  SUSPEND_OK=false
  SUSPEND_STATUS="null"
  SUSPEND_REASON=""
  if SERVICES_JSON="$(fetch_services)" && jq -e 'type == "array"' <<<"$SERVICES_JSON" >/dev/null 2>&1; then
    FINISH_FRONTEND_IDENTITY="$(resolve_frontend_identity "$SERVICES_JSON" "$PR")"
    FINISH_FRONTEND_URL="$(jq -r '.selected.url // empty' <<<"$FINISH_FRONTEND_IDENTITY")"
    BACKEND_IDENTITY="$(resolve_backend_identity "$SERVICES_JSON" "$PR" "$FINISH_FRONTEND_URL")"
    BACKEND_METHOD="$(jq -r '.method' <<<"$BACKEND_IDENTITY")"
    BACKEND_PREVIEW="$(jq -c '.selected' <<<"$BACKEND_IDENTITY")"
    if [ "$BACKEND_METHOD" = "ambiguous" ]; then
      SUSPEND_REASON="$(jq -r '.reason' <<<"$BACKEND_IDENTITY")"
      printf 'smoke-pr-gate: %s\n' "$SUSPEND_REASON" >&2
    elif [ "$BACKEND_PREVIEW" != "null" ]; then
      BACKEND_PREVIEW_ID="$(jq -r '.id // empty' <<<"$BACKEND_PREVIEW")"
      if [ -n "$BACKEND_PREVIEW_ID" ]; then
        SUSPEND_ATTEMPTED=true
        HTTP_CODE="$(timeout 10 curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
          -X POST "https://api.render.com/v1/services/$BACKEND_PREVIEW_ID/suspend" 2>/dev/null)"
        if [ -z "$HTTP_CODE" ]; then
          SUSPEND_REASON="suspend request failed (network/timeout)"
        else
          SUSPEND_STATUS="$HTTP_CODE"
          if [ "$HTTP_CODE" = "202" ]; then
            SUSPEND_OK=true
          else
            SUSPEND_REASON="suspend returned HTTP $HTTP_CODE"
          fi
        fi
      else
        SUSPEND_REASON="backend preview found but had no service id"
      fi
    else
      SUSPEND_REASON="backend preview not found (already torn down?)"
    fi
  else
    SUSPEND_REASON="failed to list services"
  fi

  HANDOFF_WRITTEN=false
  HANDOFF_REASON=""
  HANDOFF_TARGET_SHA=""
  HANDOFF_DIVERGENCE=""
  TERMINAL_EFFECT_ERROR=""
  if [ -n "$PUBLISH_FILE" ] || [ -n "$HOLD_FILE" ]; then
    FREEZE_INFO="$(detect_freeze "$PR" "$SHA")"
    if [ "$(jq -r '.filesOk' <<<"$FREEZE_INFO")" != true ]; then
      HANDOFF_REASON="could not read this PR's diff, so freeze-PR status is unknown — hold/publish/ledger not written. If this was a freeze PR the develop gate will never see this verdict; reconcile by hand"
    fi
    if [ "$(jq -r '.isFreezePr' <<<"$FREEZE_INFO")" = true ]; then
      TARGET_SHA="$(jq -r '.targetSha // empty' <<<"$FREEZE_INFO")"
      if [ -z "$TARGET_SHA" ]; then
        HANDOFF_REASON="could not determine the target develop sha for this freeze PR — hold/publish/ledger not written"
      else
        HANDOFF_TARGET_SHA="$TARGET_SHA"
        if [ -n "$HOLD_FILE" ] && [ -n "$HANDOFF_LEDGER" ] && [ -s "$HANDOFF_LEDGER" ]; then
          LEDGER_HOLDING="$(jq -cR 'fromjson? | select(type == "object") | select(.verdict != "BLOCKED")' \
            "$HANDOFF_LEDGER" 2>/dev/null | tail -1)"
          if [ -n "$LEDGER_HOLDING" ]; then
            HOLD_NOW='null'
            [ -s "$HOLD_FILE" ] && HOLD_NOW="$(jq -c '.' "$HOLD_FILE" 2>/dev/null || printf '"unparseable"')"
            if [ "$(jq -r '.verdict' <<<"$LEDGER_HOLDING")" = GO ]; then
              [ "$HOLD_NOW" = null ] || HANDOFF_DIVERGENCE="hold present after a GO"
            elif [ "$HOLD_NOW" = null ]; then
              HANDOFF_DIVERGENCE="hold missing"
            elif [ "$(jq -r '.runId // empty' <<<"$HOLD_NOW" 2>/dev/null)" != "$(jq -r '.runId' <<<"$LEDGER_HOLDING")" ]; then
              HANDOFF_DIVERGENCE="hold names a different run than the ledger"
            fi
            if [ -n "$HANDOFF_DIVERGENCE" ]; then
              DIVERGENCE_FILE="$STATE_DIR/hold-divergence-$(date -u +'%Y%m%dT%H%M%SZ')-pr$PR.json"
              jq -n --arg now "$NOW" --arg why "$HANDOFF_DIVERGENCE" --arg path "$HOLD_FILE" \
                --argjson pr "$PR" --arg run "$RUN_ID" --arg verdict "$VERDICT" \
                --argjson hold "$HOLD_NOW" --argjson ledger "$LEDGER_HOLDING" \
                '{schemaVersion:1,detectedAt:$now,divergence:$why,holdFile:$path,
                  detectedBy:{pr:$pr,runId:$run,verdict:$verdict},
                  holdBeforeOverwrite:$hold,newestHoldAffectingLedgerLine:$ledger}' \
                > "$DIVERGENCE_FILE" 2>/dev/null ||
                DIVERGENCE_FILE=""
              if [ -n "$DIVERGENCE_FILE" ] && [ -s "$DIVERGENCE_FILE" ]; then
                HANDOFF_DIVERGENCE="$DIVERGENCE_FILE"
              else
                HANDOFF_DIVERGENCE="NOT SNAPSHOTTED (write to $STATE_DIR failed): $HANDOFF_DIVERGENCE"
              fi
            fi
          fi
        fi
        HANDOFF_ARTIFACT_ERROR=""
        if [ -n "$PUBLISH_FILE" ]; then
          mkdir -p "$(dirname "$PUBLISH_FILE")" 2>/dev/null
          PUB_TMP="$(mktemp "$(dirname "$PUBLISH_FILE")/.latest-verdict.XXXXXX" 2>/dev/null)"
          if [ -n "$PUB_TMP" ]; then
            jq -cn --arg sha "$TARGET_SHA" --arg run "$RUN_ID" --arg verdict "$VERDICT" --arg now "$NOW" \
              '{schemaVersion:1,sha:$sha,runId:$run,verdict:$verdict,finishedAt:$now}' > "$PUB_TMP" 2>/dev/null
            mv "$PUB_TMP" "$PUBLISH_FILE" 2>/dev/null || rm -f "$PUB_TMP" 2>/dev/null
          fi
          jq -e --arg run "$RUN_ID" --arg sha "$TARGET_SHA" '.runId == $run and .sha == $sha' \
            "$PUBLISH_FILE" >/dev/null 2>&1 ||
            HANDOFF_ARTIFACT_ERROR="publish file $PUBLISH_FILE was not written"
        fi
        if [ -n "$HOLD_FILE" ]; then
          case "$VERDICT" in
            NO_GO|HUMAN_DECISION)
              [ "$VERDICT" = NO_GO ] &&
                HOLD_REASON="confirmed defects on this develop lineage — see the run thread and run directory" ||
                HOLD_REASON="needs_human_decision"
              mkdir -p "$(dirname "$HOLD_FILE")" 2>/dev/null
              HOLD_TMP="$(mktemp "$(dirname "$HOLD_FILE")/.develop-hold.XXXXXX" 2>/dev/null)"
              if [ -n "$HOLD_TMP" ]; then
                jq -cn --arg sha "$TARGET_SHA" --arg run "$RUN_ID" --arg now "$NOW" \
                  --arg verdict "$VERDICT" --arg reason "$HOLD_REASON" \
                  '{schemaVersion:1,sha:$sha,runId:$run,verdict:$verdict,raisedAt:$now,
                    reason:$reason}' > "$HOLD_TMP" 2>/dev/null
                mv "$HOLD_TMP" "$HOLD_FILE" 2>/dev/null || rm -f "$HOLD_TMP" 2>/dev/null
              fi
              jq -e --arg run "$RUN_ID" --arg sha "$TARGET_SHA" '.runId == $run and .sha == $sha' \
                "$HOLD_FILE" >/dev/null 2>&1 ||
                HANDOFF_ARTIFACT_ERROR="hold file $HOLD_FILE was NOT raised for this $VERDICT — promotion is ungated"
              ;;
            GO)
              rm -f "$HOLD_FILE" 2>/dev/null
              [ ! -e "$HOLD_FILE" ] ||
                HANDOFF_ARTIFACT_ERROR="hold file $HOLD_FILE could not be cleared for this GO"
              ;;
          esac
        fi
        if [ -n "$HANDOFF_ARTIFACT_ERROR" ]; then
          HANDOFF_REASON="$HANDOFF_ARTIFACT_ERROR — the ledger line below may record this attempt, but finish remains retryable with the slot and lease held."
          TERMINAL_EFFECT_ERROR="$HANDOFF_ARTIFACT_ERROR"
        else
          HANDOFF_WRITTEN=true
        fi
        if [ -n "$HANDOFF_LEDGER" ]; then
          mkdir -p "$(dirname "$HANDOFF_LEDGER")" 2>/dev/null
          LEDGER_APPENDED=false
          for LEDGER_ATTEMPT in 1 2; do
            LEDGER_LINE=""
            exec 7>"$HANDOFF_LEDGER.lock"
            if flock -w 5 7; then
              if jq -cn --arg target "$TARGET_SHA" --arg freeze "$SHA" --argjson pr "$PR" \
                --arg run "$RUN_ID" --arg verdict "$VERDICT" --arg now "$NOW" \
                --arg digest "$VERDICT_DIGEST" \
                '{schemaVersion:1,targetSha:$target,freezeSha:$freeze,freezePr:$pr,
                  runId:$run,verdict:$verdict,finishedAt:$now,verdictDigest:$digest}' >> "$HANDOFF_LEDGER"; then
                LEDGER_LINE="$(tail -1 "$HANDOFF_LEDGER" 2>/dev/null || true)"
              fi
              if [ -n "$LEDGER_LINE" ] &&
                jq -e --arg run "$RUN_ID" --arg now "$NOW" --arg digest "$VERDICT_DIGEST" \
                  '.runId == $run and .finishedAt == $now and .verdictDigest == $digest' \
                  <<<"$LEDGER_LINE" >/dev/null 2>&1; then
                LEDGER_APPENDED=true
              fi
              flock -u 7
              if [ "$LEDGER_APPENDED" = true ]; then
                break
              fi
              continue
            fi
            flock -u 7 2>/dev/null
          done
          if [ "$LEDGER_APPENDED" != true ]; then
            HANDOFF_WRITTEN=false
            if [ -n "$HANDOFF_ARTIFACT_ERROR" ]; then
              HANDOFF_REASON="$HANDOFF_REASON ALSO: ledger line was not appended to $HANDOFF_LEDGER after retry — the develop gate cannot see this outcome either."
            else
              HANDOFF_REASON="ledger line was not appended to $HANDOFF_LEDGER after retry — the develop gate cannot see this outcome. The slot and lease remain held so this finish can be retried."
            fi
            TERMINAL_EFFECT_ERROR="${TERMINAL_EFFECT_ERROR:+$TERMINAL_EFFECT_ERROR; }ledger line was not appended to $HANDOFF_LEDGER"
          fi
        fi
      fi
    fi
  fi

  if [ -n "$TERMINAL_EFFECT_ERROR" ]; then
    lease_fence_end
    flock -u 9 2>/dev/null || true
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg error "$TERMINAL_EFFECT_ERROR" \
      '{ok:false,error:("terminal artifact write failed - slot and shared lease remain held for retry: " + $error),pr:$pr,runId:$run,leaseReleased:false}'
    exit 1
  fi

  VERDICT_JSON="$(jq -cn \
    --argjson pr "$PR" --arg sha "$SHA" --arg run "$RUN_ID" --arg verdict "$VERDICT" --arg now "$NOW" \
    --argjson attempted "$SUSPEND_ATTEMPTED" --argjson ok "$SUSPEND_OK" \
    --argjson status "$SUSPEND_STATUS" --arg reason "$SUSPEND_REASON" \
    --argjson handoffWritten "$HANDOFF_WRITTEN" --arg handoffReason "$HANDOFF_REASON" \
    --arg handoffTargetSha "$HANDOFF_TARGET_SHA" --arg divergence "$HANDOFF_DIVERGENCE" \
    --arg digest "$VERDICT_DIGEST" --arg runVerdictFile "$RUN_VERDICT_FILE" \
    '{schemaVersion:1,pr:$pr,sha:$sha,runId:$run,verdict:$verdict,finishedAt:$now,
      verdictDigest:$digest,runVerdictFile:$runVerdictFile,
      suspend:{attempted:$attempted,ok:$ok,httpStatus:$status,
               reason:(if $reason == "" then null else $reason end)},
      handoff:{written:$handoffWritten,
               targetSha:(if $handoffTargetSha == "" then null else $handoffTargetSha end),
               reason:(if $handoffReason == "" then null else $handoffReason end),
               divergenceSnapshot:(if $divergence == "" then null else $divergence end)}}')"
  VERDICT_TMP="$(mktemp "$STATE_DIR/.pr-$PR-verdict.XXXXXX" 2>/dev/null)"
  if [ -z "$VERDICT_TMP" ] || ! printf '%s\n' "$VERDICT_JSON" > "$VERDICT_TMP" 2>/dev/null ||
     ! mv "$VERDICT_TMP" "$(pr_verdict_file "$PR")" 2>/dev/null ||
     ! jq -e --arg run "$RUN_ID" --arg digest "$VERDICT_DIGEST" \
       '.runId == $run and .verdictDigest == $digest' "$(pr_verdict_file "$PR")" >/dev/null 2>&1; then
    rm -f "${VERDICT_TMP:-}" 2>/dev/null || true
    lease_fence_end
    flock -u 9 2>/dev/null || true
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" \
      '{ok:false,error:"could not write the terminal PR verdict receipt - slot and shared lease remain held for retry",pr:$pr,runId:$run,leaseReleased:false}'
    exit 1
  fi

  if ! remove_pr_authority_fenced "$PR" "$RUN_ID" "$OWNER"; then
    lease_fence_end
    flock -u 9 2>/dev/null || true
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" \
      '{ok:false,error:"could not remove matching shared PR authority - terminal state not committed",pr:$pr,runId:$run,leaseReleased:false}'
    exit 1
  fi
  if ! lease_remove_fenced "$RUN_ID"; then
    write_pr_authority "$PR" "$FENCED_AUTHORITY_JSON" || true
    lease_fence_end
    flock -u 9 2>/dev/null || true
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg dir "$LEASE_DIR" \
      '{ok:false,error:("could not remove the shared lease under " + $dir + " - terminal state not committed"),pr:$pr,runId:$run,leaseReleased:false}'
    exit 1
  fi
  STATE="$(jq -c \
    --arg sha "$SHA" --arg run "$RUN_ID" --arg verdict "$VERDICT" --arg now "$NOW" \
    --arg digest "$VERDICT_DIGEST" \
    '.completedSha=$sha | .completedAt=$now | .completedRunId=$run | .completedVerdict=$verdict |
     .completedVerdictDigest=$digest | .finishIntent=null |
     .activeSha=null | .activeStartedAt=null | .activeRunId=null | .activeProgressAt=null |
     .activeLeaseOwner=null | .challengerDeadline=null' <<<"$STATE")"
  if ! write_pr_state "$PR" "$STATE"; then
    RESTORED=false
    if lease_restore_fenced "$RUN_ID" "$FENCED_LEASE_JSON" &&
       write_pr_authority "$PR" "$FENCED_AUTHORITY_JSON"; then RESTORED=true; fi
    lease_fence_end
    flock -u 9 2>/dev/null || true
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --argjson restored "$RESTORED" \
      '{ok:false,error:"could not commit terminal PR state - no success receipt returned and lease restoration attempted",pr:$pr,runId:$run,leaseReleased:false,leaseRestored:$restored}'
    exit 1
  fi

  lease_fence_end
  flock -u 9

  jq -cn --argjson verdict "$VERDICT_JSON" '{ok:true,leaseReleased:true} + $verdict'
  exit 0
fi

if [ "$COMMAND" = "challenger-timeout" ]; then
  RUN_ID="${2:-}"
  OWNER="${3:-$DEFAULT_OWNER}"
  if ! run_id_ok "$RUN_ID"; then
    jq -cn --arg run "$RUN_ID" \
      '{ok:false,error:"challenger-timeout requires a run id of 1-200 chars of [A-Za-z0-9._-]",runId:$run}'
    exit 2
  fi
  PR="$(find_pr_for_run "$RUN_ID" || true)"
  if [ -z "${PR:-}" ]; then
    emit_not_active "$RUN_ID" "not the active run (reclaimed or already finished) — nothing to time out"
    exit 0
  fi
  exec 9>"$(pr_lock_file "$PR")"
  if ! flock -w "$LOCK_WAIT" 9; then
    emit_lock_busy "$COMMAND" "$PR"
    exit 0
  fi
  STATE="$(read_pr_state "$PR")"
  if [ "$RUN_ID" != "$(jq -r '.activeRunId // empty' <<<"$STATE")" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" \
      --arg active "$(jq -r '.activeRunId // empty' <<<"$STATE")" \
      '{ok:false,error:"not the active run — nothing to time out",
        pr:$pr,runId:$run,activeRunId:(if $active == "" then null else $active end)}'
    exit 0
  fi
  STORED_OWNER="$(jq -r '.activeLeaseOwner // empty' <<<"$STATE")"
  if [ -z "$STORED_OWNER" ] || [ "$OWNER" != "$STORED_OWNER" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg owner "$OWNER" --arg stored "$STORED_OWNER" \
      '{ok:false,error:"caller owner does not match the owner recorded by claim - challenger timeout refused",pr:$pr,runId:$run,requestedBy:$owner,claimedBy:(if $stored == "" then null else $stored end)}'
    exit 0
  fi
  DEADLINE="$(jq -r '.challengerDeadline // empty' <<<"$STATE")"
  if [ -z "$DEADLINE" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" \
      '{ok:false,error:"this run has no challengerDeadline — it was claimed before deadlines were stamped, so there is nothing to time out. Release it or finish it explicitly.",
        pr:$pr,runId:$run}'
    exit 2
  fi
  REMAINING="$(( $(epoch_or_zero "$DEADLINE") - $(date -u +%s) ))"
  if [ "$REMAINING" -gt 0 ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg deadline "$DEADLINE" \
      --argjson remaining "$REMAINING" \
      '{ok:false,error:"the challenger deadline has not passed — keep waiting",
        pr:$pr,runId:$run,challengerDeadline:$deadline,remainingSeconds:$remaining}'
    exit 0
  fi
  if [ -z "$CHALLENGER_RUN_ROOT" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" \
      '{ok:false,error:"SMOKE_GATE_RUN_ROOT is not set, so the gate cannot look for challenger/disposition.md — refusing to declare a disposition missing that it never checked for. Wire SMOKE_GATE_RUN_ROOT to the run root, or finish this run explicitly.",
        pr:$pr,runId:$run}'
    exit 2
  fi
  if [ ! -d "$CHALLENGER_RUN_ROOT" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg root "$CHALLENGER_RUN_ROOT" \
      '{ok:false,error:("SMOKE_GATE_RUN_ROOT " + $root + " is not readable — the lookup failed, which is not the same as a missing disposition. Fix the mount and retry."),
        pr:$pr,runId:$run,runRoot:$root}'
    exit 2
  fi
  DISPOSITION_FILE="$(challenger_disposition_file "$RUN_ID")"
  if [ -s "$DISPOSITION_FILE" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" --arg path "$DISPOSITION_FILE" \
      '{ok:false,error:"the challenger DID file a disposition — nothing timed out. Synthesize and finish normally.",
        pr:$pr,runId:$run,dispositionFile:$path}'
    exit 0
  fi
  NOW="$(iso_now)"
  SHA="$(jq -r '.activeSha // empty' <<<"$STATE")"
  if ! lease_fence_begin "$PR" "$RUN_ID" "$OWNER" "$COMMAND"; then
    exit 0
  fi
  STATE="$(jq -c --arg now "$NOW" --arg deadline "$DEADLINE" \
    '.challengerDisposition="no-disposition" | .challengerTimedOutAt=$now' <<<"$STATE")"
  if ! write_pr_state "$PR" "$STATE"; then
    lease_fence_end
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" \
      '{ok:false,error:"could not write challenger-timeout state - no terminal action attempted",pr:$pr,runId:$run}'
    exit 1
  fi
  lease_fence_end
  flock -u 9
  exec 9>&-
  if [ -z "$SHA" ]; then
    jq -cn --argjson pr "$PR" --arg run "$RUN_ID" \
      '{ok:false,challengerDisposition:"no-disposition",
        error:"recorded no-disposition, but this run has no claimed sha to finish against — reconcile by hand",
        pr:$pr,runId:$run}'
    exit 1
  fi
  FINISH_OUT="$(bash "$0" finish "$SHA" "$RUN_ID" BLOCKED "$OWNER")"
  FINISH_RC=$?
  jq -cn --argjson finish "$FINISH_OUT" --arg deadline "$DEADLINE" --arg at "$NOW" \
    --arg path "$DISPOSITION_FILE" \
    '$finish + {challengerDisposition:"no-disposition",challengerDeadline:$deadline,
                challengerTimedOutAt:$at,expectedDispositionFile:$path}' 2>/dev/null ||
    printf '%s\n' "$FINISH_OUT"
  exit "$FINISH_RC"
fi

if [ "$COMMAND" != "poll" ]; then
  jq -cn --arg command "$COMMAND" \
    '{ok:false,error:("unknown command: " + $command),
      commands:["poll","check","claim","release","progress","finish",
                "lease-claim","lease-renew","lease-release","lease-status",
                "challenger-timeout"]}'
  exit 2
fi

MISSING=""
[ -n "$REPO" ] || MISSING="$MISSING SMOKE_GATE_REPO"
[ -n "$BACKEND_SERVICE" ] || MISSING="$MISSING SMOKE_GATE_BACKEND_SERVICE"
[ -n "$FRONTEND_SERVICE" ] || MISSING="$MISSING SMOKE_GATE_FRONTEND_SERVICE"
MISSING="$MISSING$BAD_NUMERIC_CONFIG"
if [ -n "$MISSING" ]; then
  exec 8>"$CONTROL_LOCK"
  flock -w 5 8 || true
  CONTROL="$(read_control)"
  LAST="$(epoch_or_zero "$(jq -r '.lastMisconfigWakeAt // empty' <<<"$CONTROL")")"
  NOW_EPOCH="$(date -u +%s)"
  WAKE=false
  if [ "$(( NOW_EPOCH - LAST ))" -ge 21600 ]; then
    WAKE=true
    CONTROL="$(jq -c --arg now "$(iso_now)" '.lastMisconfigWakeAt=$now' <<<"$CONTROL")"
  fi
  write_control "$CONTROL"
  jq -cn --argjson wake "$WAKE" \
    --argjson missing "$(printf '%s\n' $MISSING | jq -Rsc 'split("\n") | map(select(length > 0))')" \
    '{ok:false,settled:false,wakeAgent:$wake,data:{schemaVersion:1,trigger:"gate_misconfigured",settled:false,missing:$missing}}'
  exit 0
fi

PR_LIST_JSON="$(timeout 10 gh pr list -R "$REPO" --base "$BRANCH" --label "$LABEL" --state open \
  --json number,headRefOid,headRefName --limit 100 2>/dev/null)"
PR_LIST_RC=$?
PR_LIST_LEN="$(jq -r 'length' <<<"$PR_LIST_JSON" 2>/dev/null || printf -- '-1')"
REPO_PROBE_OK=true
if [ "$PR_LIST_RC" -eq 0 ] && [ "$PR_LIST_LEN" = "0" ]; then
  timeout 10 gh repo view "$REPO" --json name >/dev/null 2>&1 || REPO_PROBE_OK=false
fi
if [ "$PR_LIST_RC" -ne 0 ] || [ "$REPO_PROBE_OK" != true ] || \
   ! jq -e 'type == "array"' <<<"$PR_LIST_JSON" >/dev/null 2>&1 || \
   [ "$PR_LIST_LEN" -ge 100 ] 2>/dev/null; then
  exec 8>"$CONTROL_LOCK"
  flock -w 5 8 || true
  CONTROL="$(read_control)"
  FAILURES="$(( $(jq -r '.fetchFailures // 0' <<<"$CONTROL") + 1 ))"
  if [ "$FAILURES" -gt 3 ]; then FAILURES=3; fi
  CONTROL="$(jq -c --argjson f "$FAILURES" '.fetchFailures=$f' <<<"$CONTROL")"
  WAKE=false
  if [ "$FAILURES" -ge 3 ]; then
    LAST="$(epoch_or_zero "$(jq -r '.lastFailureWakeAt // empty' <<<"$CONTROL")")"
    NOW_EPOCH="$(date -u +%s)"
    if [ "$(( NOW_EPOCH - LAST ))" -ge 21600 ]; then
      WAKE=true
      CONTROL="$(jq -c --arg now "$(iso_now)" '.fetchFailures=0 | .lastFailureWakeAt=$now' <<<"$CONTROL")"
    fi
  fi
  write_control "$CONTROL"
  jq -cn --argjson wake "$WAKE" --argjson failures "$FAILURES" \
    '{ok:false,settled:false,wakeAgent:$wake,data:{schemaVersion:1,trigger:"gate_fetch_failed",settled:false,consecutiveFailures:$failures}}'
  exit 0
fi
exec 8>"$CONTROL_LOCK"
flock -w 5 8 || true
CONTROL="$(jq -c '.fetchFailures=0' <<<"$(read_control)")"
write_control "$CONTROL"
flock -u 8

PR_COUNT="$(jq -r 'length' <<<"$PR_LIST_JSON")"
if [ "$PR_COUNT" -eq 0 ]; then
  jq -cn '{wakeAgent:false,data:{schemaVersion:1,trigger:"waiting_for_candidates",labeledPrCount:0}}'
  exit 0
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
ALARM_CANDIDATES="$TMP_DIR/alarms.jsonl"
SETTLE_CANDIDATES="$TMP_DIR/settles.jsonl"
: > "$ALARM_CANDIDATES"
: > "$SETTLE_CANDIDATES"
NOW_EPOCH="$(date -u +%s)"

while IFS= read -r ROW; do
  PR="$(jq -r '.number' <<<"$ROW")"
  HEAD_SHA="$(jq -r '.headRefOid' <<<"$ROW")"
  HEAD_REF="$(jq -r '.headRefName // empty' <<<"$ROW")"
  printf '%s' "$HEAD_SHA" | grep -Eq '^[0-9a-f]{40}$' || continue

  FACTS="$(evaluate_pr "$PR" "$HEAD_SHA" "$HEAD_REF")"

  if [ "$(jq -r '.fetchOk' <<<"$FACTS")" != true ]; then
    exec 9>"$(pr_lock_file "$PR")"
    if flock -w 5 9; then
      STATE="$(read_pr_state "$PR")"
      if [ "$(jq -r '.factsStuckSha // empty' <<<"$STATE")" != "$HEAD_SHA" ]; then
        STATE="$(jq -c --arg sha "$HEAD_SHA" --arg now "$(iso_now)" \
          '.factsStuckSha=$sha | .factsStuckSince=$now' <<<"$STATE")"
        write_pr_state "$PR" "$STATE"
      fi
      STUCK_SINCE="$(epoch_or_zero "$(jq -r '.factsStuckSince // empty' <<<"$STATE")")"
      STUCK_ALERT_SHA="$(jq -r '.factsStuckAlertSha // empty' <<<"$STATE")"
      flock -u 9
      exec 9>&-
      if [ "$STUCK_ALERT_SHA" != "$HEAD_SHA" ] && [ "$STUCK_SINCE" -gt 0 ] &&
         [ "$(( NOW_EPOCH - STUCK_SINCE ))" -ge "$FACTS_STUCK_TIMEOUT" ]; then
        jq -cn --argjson pr "$PR" --arg sha "$HEAD_SHA" '{pr:$pr,sha:$sha,subtype:"facts"}' >> "$ALARM_CANDIDATES"
      fi
    else
      exec 9>&-
    fi
    continue
  fi

  exec 9>"$(pr_lock_file "$PR")"
  if ! flock -w "$LOCK_WAIT" 9; then
    exec 9>&-
    continue
  fi
  STATE="$(read_pr_state "$PR")"
  STATE_DIRTY=false

  if [ -n "$(jq -r '.factsStuckSha // empty' <<<"$STATE")" ]; then
    STATE="$(jq -c '.factsStuckSha=null | .factsStuckSince=null | .factsStuckAlertSha=null' <<<"$STATE")"
    STATE_DIRTY=true
  fi

  BACKEND_READY="$(jq -r '.backendReady' <<<"$FACTS")"
  if [ "$BACKEND_READY" = true ]; then
    if [ "$(jq -r '.deployLiveSha // empty' <<<"$STATE")" != "$HEAD_SHA" ]; then
      STATE="$(jq -c --arg sha "$HEAD_SHA" --arg now "$(iso_now)" \
        '.deployLiveSha=$sha | .deployLiveSince=$now' <<<"$STATE")"
      STATE_DIRTY=true
    fi
  fi
  if [ "$STATE_DIRTY" = true ]; then
    write_pr_state "$PR" "$STATE"
  fi
  flock -u 9
  exec 9>&-

  ACTIVE_RUN="$(jq -r '.activeRunId // empty' <<<"$STATE")"
  OVERRUN_LAST="$(jq -r '.overrunAlertAt // empty' <<<"$STATE")"
  OVERRUN_SINCE="$(( $(date -u +%s) - $(epoch_or_zero "$OVERRUN_LAST") ))"
  if [ -n "$ACTIVE_RUN" ] &&
     [ "$(active_run_is_live "$(jq -r '.activeStartedAt // empty' <<<"$STATE")" \
                             "$(jq -r '.activeProgressAt // empty' <<<"$STATE")")" = true ] &&
     { [ "$(jq -r '.overrunAlertRunId // empty' <<<"$STATE")" != "$ACTIVE_RUN" ] ||
       [ "$OVERRUN_SINCE" -ge "$OVERRUN_REALERT_SECONDS" ]; }; then
    ACTIVE_AGE="$(active_run_age "$(jq -r '.activeStartedAt // empty' <<<"$STATE")")"
    if [ "$ACTIVE_AGE" -ge "$ACTIVE_STALE_SECONDS" ]; then
      jq -cn --argjson pr "$PR" --arg sha "$(jq -r '.activeSha // empty' <<<"$STATE")" \
        --arg run "$ACTIVE_RUN" --argjson age "$ACTIVE_AGE" \
        '{pr:$pr,sha:$sha,subtype:"overrun",runId:$run,activeAgeSeconds:$age}' >> "$ALARM_CANDIDATES"
      continue
    fi
  fi

  MIGRATIONS_TOUCHED="$(jq -r '.migrationsTouched' <<<"$FACTS")"
  REFUSED_ALERT_SHA="$(jq -r '.refusedAlertSha // empty' <<<"$STATE")"
  if [ "$MIGRATIONS_TOUCHED" = true ] && [ "$REFUSED_ALERT_SHA" != "$HEAD_SHA" ]; then
    jq -cn --argjson pr "$PR" --arg sha "$HEAD_SHA" \
      --argjson files "$(jq -c '.migrationFiles // []' <<<"$FACTS")" \
      --argjson determinable "$(jq -c '.migrationsDeterminable // false' <<<"$FACTS")" \
      '{pr:$pr,sha:$sha,subtype:"migrations",migrationFiles:$files,migrationsDeterminable:$determinable}' >> "$ALARM_CANDIDATES"
    continue
  fi

  COMPLETED_SHA="$(jq -r '.completedSha // empty' <<<"$STATE")"
  HEALTHZ_READY="$(jq -r '.healthzReady' <<<"$FACTS")"
  WARMUP_ALERT_SHA="$(jq -r '.warmupAlertSha // empty' <<<"$STATE")"
  if [ "$BACKEND_READY" = true ] && [ "$HEALTHZ_READY" != true ] && \
     [ "$WARMUP_ALERT_SHA" != "$HEAD_SHA" ] && [ "$COMPLETED_SHA" != "$HEAD_SHA" ]; then
    LIVE_SINCE_EPOCH="$(epoch_or_zero "$(jq -r '.deployLiveSince // empty' <<<"$STATE")")"
    if [ "$LIVE_SINCE_EPOCH" -gt 0 ] && [ "$(( NOW_EPOCH - LIVE_SINCE_EPOCH ))" -ge "$WARMUP_TIMEOUT" ]; then
      jq -cn --argjson pr "$PR" --arg sha "$HEAD_SHA" '{pr:$pr,sha:$sha,subtype:"warmup"}' >> "$ALARM_CANDIDATES"
      continue
    fi
  fi

  SETTLED="$(jq -r '.settled' <<<"$FACTS")"
  [ "$SETTLED" = true ] || continue

  [ "$COMPLETED_SHA" != "$HEAD_SHA" ] || continue

  ACTIVE_SHA="$(jq -r '.activeSha // empty' <<<"$STATE")"
  if [ -n "$ACTIVE_SHA" ] && [ "$(active_run_is_live \
        "$(jq -r '.activeStartedAt // empty' <<<"$STATE")" \
        "$(jq -r '.activeProgressAt // empty' <<<"$STATE")")" = true ]; then
    continue
  fi

  RECOVERY=false
  ABANDONED=""
  if [ -n "$ACTIVE_SHA" ]; then RECOVERY=true; ABANDONED="$ACTIVE_SHA"; fi
  jq -cn --argjson pr "$PR" --argjson facts "$FACTS" --argjson recovery "$RECOVERY" --arg abandoned "$ABANDONED" \
    '{pr:$pr,facts:$facts,recovery:$recovery,abandonedActiveSha:(if $abandoned == "" then null else $abandoned end)}' \
    >> "$SETTLE_CANDIDATES"
done < <(jq -c '.[]' <<<"$PR_LIST_JSON")

if [ -s "$ALARM_CANDIDATES" ]; then
  WINNER="$(jq -sc 'sort_by(.pr) | .[0]' "$ALARM_CANDIDATES")"
  W_PR="$(jq -r '.pr' <<<"$WINNER")"
  W_SHA="$(jq -r '.sha' <<<"$WINNER")"
  W_SUB="$(jq -r '.subtype' <<<"$WINNER")"
  exec 9>"$(pr_lock_file "$W_PR")"
  if flock -w 5 9; then
    STATE="$(read_pr_state "$W_PR")"
    FIELD="refusedAlertSha"
    W_KEY="$W_SHA"
    [ "$W_SUB" = "warmup" ] && FIELD="warmupAlertSha"
    [ "$W_SUB" = "facts" ] && FIELD="factsStuckAlertSha"
    if [ "$W_SUB" = "overrun" ]; then
      FIELD="overrunAlertRunId"
      W_KEY="$(jq -r '.runId' <<<"$WINNER")"
    fi
    ALREADY="$(jq -r --arg f "$FIELD" '.[$f] // empty' <<<"$STATE")"
    REARM=false
    if [ "$W_SUB" = "overrun" ]; then
      OVERRUN_LAST="$(jq -r '.overrunAlertAt // empty' <<<"$STATE")"
      [ "$(( $(date -u +%s) - $(epoch_or_zero "$OVERRUN_LAST") ))" -ge "$OVERRUN_REALERT_SECONDS" ] && REARM=true
    fi
    if [ "$ALREADY" != "$W_KEY" ] || [ "$REARM" = true ]; then
      STATE="$(jq -c --arg f "$FIELD" --arg key "$W_KEY" '.[$f]=$key' <<<"$STATE")"
      if [ "$W_SUB" = "overrun" ]; then
        STATE="$(jq -c --arg now "$(iso_now)" '.overrunAlertAt=$now' <<<"$STATE")"
      fi
      write_pr_state "$W_PR" "$STATE"
      TRIGGER="pr_migrations_refused"
      [ "$W_SUB" = "warmup" ] && TRIGGER="pr_warmup_stuck"
      [ "$W_SUB" = "facts" ] && TRIGGER="pr_facts_unavailable"
      [ "$W_SUB" = "overrun" ] && TRIGGER="pr_run_overrun"
      jq -cn --argjson pr "$W_PR" --arg sha "$W_SHA" --arg trigger "$TRIGGER" \
        --argjson files "$(jq -c '.migrationFiles // []' <<<"$WINNER")" \
        --argjson determinable "$(jq -c '.migrationsDeterminable // false' <<<"$WINNER")" \
        --arg run "$(jq -r '.runId // ""' <<<"$WINNER")" \
        --argjson age "$(jq -r '.activeAgeSeconds // "null"' <<<"$WINNER")" \
        '{wakeAgent:true,data:{schemaVersion:1,trigger:$trigger,pr:$pr,sourceSha:$sha,
          migrationFiles:$files,migrationsDeterminable:$determinable,
          runId:(if $run == "" then null else $run end),activeAgeSeconds:$age}}'
      exit 0
    fi
  fi
fi

if [ -s "$SETTLE_CANDIDATES" ]; then
  WINNER="$(jq -sc 'sort_by(.pr) | .[0]' "$SETTLE_CANDIDATES")"
  W_PR="$(jq -r '.pr' <<<"$WINNER")"
  FACTS="$(jq -c '.facts' <<<"$WINNER")"
  RECOVERY="$(jq -r '.recovery' <<<"$WINNER")"
  ABANDONED="$(jq -r '.abandonedActiveSha' <<<"$WINNER")"
  HEAD_SHA="$(jq -r '.headSha' <<<"$FACTS")"

  if [ -n "$PREFLIGHT_CMD" ]; then
    exec 8>"$CONTROL_LOCK"
    flock -w 5 8 || true
    CONTROL="$(read_control)"
    PREFLIGHT_OUT="$TMP_DIR/preflight.out"
    PREFLIGHT_TARGET_URL="$(jq -r '.backendPreviewUrl // empty' <<<"$FACTS")"
    if [ -z "$PREFLIGHT_TARGET_URL" ]; then
      jq -cn '{wakeAgent:false,data:{schemaVersion:1,trigger:"pr_preflight_failed",
        reason:"settled candidate has no backend preview URL to run a target-aware preflight against"}}'
      exit 0
    fi
    export SMOKE_GATE_PREFLIGHT_TARGET_URL="$PREFLIGHT_TARGET_URL"
    if timeout "$PREFLIGHT_TIMEOUT" bash -c "$PREFLIGHT_CMD" >"$PREFLIGHT_OUT" 2>&1; then
      CONTROL="$(jq -c '.preflightReason=null | .preflightFingerprint=null | .preflightWakeAt=null' <<<"$CONTROL")"
      write_control "$CONTROL"
      flock -u 8
      exec 8>&-
    else
      PREFLIGHT_RC=$?
      PREFLIGHT_REASON="$(grep -v '^[[:space:]]*$' "$PREFLIGHT_OUT" 2>/dev/null | tail -1 | cut -c1-300)"
      [ -n "$PREFLIGHT_REASON" ] || PREFLIGHT_REASON="preflight command exited $PREFLIGHT_RC with no output"
      [ "$PREFLIGHT_RC" -eq 124 ] && PREFLIGHT_REASON="preflight timed out after ${PREFLIGHT_TIMEOUT}s: $PREFLIGHT_REASON"
      PREFLIGHT_FINGERPRINT="pr|$PREFLIGHT_REASON|$W_PR"
      LAST_PREFLIGHT_FINGERPRINT="$(jq -r '.preflightFingerprint // empty' <<<"$CONTROL")"
      SINCE_WAKE="$(( NOW_EPOCH - $(epoch_or_zero "$(jq -r '.preflightWakeAt // empty' <<<"$CONTROL")") ))"
      if { [ "$PREFLIGHT_FINGERPRINT" != "$LAST_PREFLIGHT_FINGERPRINT" ] && [ "$SINCE_WAKE" -ge "$PREFLIGHT_REARM_FLOOR_SECONDS" ]; } ||
         [ "$SINCE_WAKE" -ge "$PREFLIGHT_ALERT_SECONDS" ]; then
        CONTROL="$(jq -c --arg r "$PREFLIGHT_REASON" --arg f "$PREFLIGHT_FINGERPRINT" --arg now "$(iso_now)" \
          '.preflightReason=$r | .preflightFingerprint=$f | .preflightWakeAt=$now' <<<"$CONTROL")"
        write_control "$CONTROL"
        jq -cn --arg reason "$PREFLIGHT_REASON" --argjson rc "$PREFLIGHT_RC" --arg fp "$PREFLIGHT_FINGERPRINT" \
          --argjson pr "$W_PR" \
          '{wakeAgent:true,data:{schemaVersion:1,trigger:"pr_preflight_failed",pr:$pr,reason:$reason,exitCode:$rc,fingerprint:$fp}}'
        exit 0
      fi
      CONTROL="$(jq -c --arg r "$PREFLIGHT_REASON" '.preflightReason=$r' <<<"$CONTROL")"
      write_control "$CONTROL"
      jq -cn '{wakeAgent:false,data:{schemaVersion:1,trigger:"pr_preflight_failed"}}'
      exit 0
    fi
  fi

  exec 9>"$(pr_lock_file "$W_PR")"
  if ! flock -w "$LOCK_WAIT" 9; then
    jq -cn '{wakeAgent:false,data:{schemaVersion:1,trigger:"gate_lock_failed"}}'
    exit 0
  fi
  STATE="$(read_pr_state "$W_PR")"
  COMPLETED_SHA="$(jq -r '.completedSha // empty' <<<"$STATE")"
  ACTIVE_SHA="$(jq -r '.activeSha // empty' <<<"$STATE")"
  if [ "$COMPLETED_SHA" = "$HEAD_SHA" ] ||
     { [ -n "$ACTIVE_SHA" ] && [ "$(active_run_is_live \
          "$(jq -r '.activeStartedAt // empty' <<<"$STATE")" \
          "$(jq -r '.activeProgressAt // empty' <<<"$STATE")")" = true ]; }; then
    jq -cn '{wakeAgent:false,data:{schemaVersion:1,trigger:"waiting_for_candidates"}}'
    exit 0
  fi

  RESUMED_RUN_ID=false
  if [ "$(jq -r --arg sha "$HEAD_SHA" \
        'if (.activeSha == $sha and .challengerDisposition == null and (.activeRunId // "") != "")
         then "true" else "false" end' <<<"$STATE")" = true ]; then
    RUN_ID="$(jq -r '.activeRunId' <<<"$STATE")"
    RESUMED_RUN_ID=true
  else
    RUN_STAMP_EPOCH="$(date -u +%s)"
    RUN_ID="${RUN_PREFIX}-pr${W_PR}-${HEAD_SHA:0:12}-$(date -u -d "@$RUN_STAMP_EPOCH" +%Y%m%dT%H%M%SZ)"
    while [ "$RUN_ID" = "$(jq -r '.activeRunId // empty' <<<"$STATE")" ] ||
          [ "$RUN_ID" = "$(jq -r '.completedRunId // empty' <<<"$STATE")" ]; do
      RUN_STAMP_EPOCH="$(( RUN_STAMP_EPOCH + 1 ))"
      RUN_ID="${RUN_PREFIX}-pr${W_PR}-${HEAD_SHA:0:12}-$(date -u -d "@$RUN_STAMP_EPOCH" +%Y%m%dT%H%M%SZ)"
    done
  fi
  OWNER_TOKEN="$(new_owner_token || true)"
  if [ -z "$OWNER_TOKEN" ]; then
    emit_poll_lease_failure '{"ok":false,"error":"could not generate a coordinator owner token"}'
    exit 0
  fi
  LEASE_ERROR_FILE="$TMP_DIR/lease-error.json"
  if ! lease_lifecycle_begin "$W_PR" "$RUN_ID" "poll" >"$LEASE_ERROR_FILE"; then
    emit_poll_lease_failure "$(cat "$LEASE_ERROR_FILE")"
    exit 0
  fi
  PRIOR_AUTHORITY="$(read_pr_authority "$W_PR")"
  AUTHORITY_STATUS="$(pr_authority_status "$PRIOR_AUTHORITY")"
  if [ "$AUTHORITY_STATUS" = malformed ]; then
    lease_lifecycle_end
    emit_poll_lease_failure "$(jq -cn --arg path "$(pr_authority_file "$W_PR")" '{ok:false,error:("shared PR authority is malformed at " + $path)}')"
    exit 0
  fi
  if [ "$AUTHORITY_STATUS" = live ] &&
     { [ "$(jq -r '.runId' <<<"$PRIOR_AUTHORITY")" != "$RUN_ID" ] ||
       [ "$(jq -r '.owner' <<<"$PRIOR_AUTHORITY")" != "$OWNER_TOKEN" ]; }; then
    lease_lifecycle_end
    emit_poll_lease_failure "$(jq -cn --argjson authority "$PRIOR_AUTHORITY" '{ok:false,error:"another live coordinator owns this PR",leaseOwner:$authority.owner,activeRunId:$authority.runId}')"
    exit 0
  fi
  PRIOR_LEASE="$(read_lease "$RUN_ID")"
  if ! LEASE_RESULT="$(lease_acquire "$RUN_ID" "$OWNER_TOKEN" "$W_PR")"; then
    lease_lifecycle_end
    emit_poll_lease_failure "$LEASE_RESULT"
    exit 0
  fi
  if ! bind_pr_authority "$W_PR" "$RUN_ID" "$OWNER_TOKEN"; then
    ACQUIRED_LEASE="$(jq -c '.lease' <<<"$LEASE_RESULT")"
    FAILED_AUTHORITY="$(read_pr_authority "$W_PR")"
    lease_lifecycle_end
    BIND_FAILURE='{"ok":false,"error":"could not write shared PR authority"}'
    if rollback_poll_ownership "$W_PR" "$RUN_ID" "$OWNER_TOKEN" "$PRIOR_LEASE" "$PRIOR_AUTHORITY" "$ACQUIRED_LEASE" "$FAILED_AUTHORITY"; then
      emit_poll_lease_failure "$BIND_FAILURE"
    else
      emit_poll_lease_failure "$(jq -c --arg owner "$OWNER_TOKEN" \
        '.retryable=false | .error=(.error + "; automatic ownership rollback failed") | .coordinatorOwnerToken=$owner' <<<"$BIND_FAILURE")"
    fi
    exit 0
  fi
  ACQUIRED_LEASE="$(jq -c '.lease' <<<"$LEASE_RESULT")"
  ACQUIRED_AUTHORITY="$(read_pr_authority "$W_PR")"
  if [ -n "${SMOKE_GATE_SHARED_ROOT+x}" ] && [ "$SMOKE_GATE_SHARED_ROOT" != /workspace/workgroup ] &&
     printf '%s' "${SMOKE_GATE_TEST_HOLD_RUN_LOCK_AFTER_BIND_SECONDS:-}" | grep -Eq '^[0-9]+([.][0-9]+)?$'; then
    TEST_LOCK_READY="$TMP_DIR/test-run-lock-ready"
    ( flock -x 7
      : >"$TEST_LOCK_READY"
      sleep "$SMOKE_GATE_TEST_HOLD_RUN_LOCK_AFTER_BIND_SECONDS"
    ) 7>"$(lease_lock_file "$RUN_ID")" &
    for _wait in $(seq 1 100); do [ -e "$TEST_LOCK_READY" ] && break; sleep 0.01; done
  fi
  if ! lease_fence_begin "$W_PR" "$RUN_ID" "$OWNER_TOKEN" "poll" >"$LEASE_ERROR_FILE"; then
    LEASE_FAILURE="$(cat "$LEASE_ERROR_FILE")"
    if rollback_poll_ownership "$W_PR" "$RUN_ID" "$OWNER_TOKEN" "$PRIOR_LEASE" "$PRIOR_AUTHORITY" "$ACQUIRED_LEASE" "$ACQUIRED_AUTHORITY"; then
      emit_poll_lease_failure "$LEASE_FAILURE"
    else
      emit_poll_lease_failure "$(jq -c --arg owner "$OWNER_TOKEN" \
        '.retryable=false | .error=(.error + "; automatic ownership rollback failed") | .coordinatorOwnerToken=$owner' <<<"$LEASE_FAILURE")"
    fi
    exit 0
  fi
  NOW="$(iso_now)"
  STATE="$(jq -c --arg sha "$HEAD_SHA" --arg now "$NOW" --arg run "$RUN_ID" --arg owner "$OWNER_TOKEN" \
    --arg deadline "$(challenger_deadline_from_now)" \
    '(if (.activeSha == $sha and (.challengerDeadline // "") != "" and .challengerDisposition == null)
      then .challengerDeadline else $deadline end) as $dl |
     .activeSha=$sha | .activeStartedAt=$now | .activeRunId=$run | .activeProgressAt=null |
     .activeLeaseOwner=$owner |
     .challengerDeadline=$dl |
     .challengerDisposition=null | .challengerTimedOutAt=null | .finishIntent=null' <<<"$STATE")"
  if ! write_pr_state "$W_PR" "$STATE"; then
    lease_fence_end
    SLOT_FAILURE='{"ok":false,"error":"could not persist the claimed coordinator slot"}'
    if rollback_poll_ownership "$W_PR" "$RUN_ID" "$OWNER_TOKEN" "$PRIOR_LEASE" "$PRIOR_AUTHORITY" "$ACQUIRED_LEASE" "$ACQUIRED_AUTHORITY"; then
      emit_poll_lease_failure "$SLOT_FAILURE"
    else
      emit_poll_lease_failure "$(jq -c --arg owner "$OWNER_TOKEN" \
        '.retryable=false | .error=(.error + "; automatic ownership rollback failed") | .coordinatorOwnerToken=$owner' <<<"$SLOT_FAILURE")"
    fi
    exit 0
  fi
  lease_fence_end

  jq -cn \
    --arg repo "$REPO" --arg branch "$BRANCH" --argjson pr "$W_PR" --arg runId "$RUN_ID" \
    --arg ownerToken "$OWNER_TOKEN" \
    --argjson facts "$FACTS" --argjson recovery "$RECOVERY" \
    --arg abandoned "$ABANDONED" \
    --argjson resumedRunId "$RESUMED_RUN_ID" \
    '{wakeAgent:true,data:({
      schemaVersion:1, trigger:"pr_build_settled",
      repo:$repo, branch:$branch, pr:$pr, runId:$runId, coordinatorOwnerToken:$ownerToken,
      resumedRunId:$resumedRunId,
      sourceSha:$facts.headSha,
      previewUrl:$facts.backendPreviewUrl,
      frontendPreviewUrl:$facts.frontendPreviewUrl,
      isFreezePr:$facts.isFreezePr, ciSha:$facts.ciSha,
      campaignSize:$facts.campaignSize, sizeReason:$facts.sizeReason,
      recovery:$recovery,
      abandonedActiveSha:(if $abandoned == "" or $abandoned == "null" then null else $abandoned end)
    })}'
  exit 0
fi

jq -cn --argjson count "$PR_COUNT" \
  '{wakeAgent:false,data:{schemaVersion:1,trigger:"waiting_for_candidates",labeledPrCount:$count}}'
