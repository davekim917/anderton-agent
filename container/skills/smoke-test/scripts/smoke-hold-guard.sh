# Sourced by both gates, never run: every finish that raises or clears the
# shared develop hold decides under the same sidecar lock and by the same rule.

# Takes the hold's sidecar lock on fd 3. The sidecar is a regular file this
# gate creates without following or replacing anything at its path (link(2)
# fails on any existing name, symlink included) and never replaces after. An
# existing symlink, FIFO or other non-regular sidecar is refused, bounded and
# retryable, before any open. Only the gates may modify the lock's path: a
# swap inside the check-to-open window is a residual that fails closed (a
# changed inode is refused; a FIFO can block the open until the caller's own
# budget ends it, hold untouched). Sets HOLD_LOCK_WHY on failure.
hold_lock_take() {  # <lock-path> <wait-seconds>
  local lock="$1" wait="$2" dir tmp id
  HOLD_LOCK_WHY=""
  dir="$(dirname "$lock")"
  mkdir -p "$dir" 2>/dev/null || { HOLD_LOCK_WHY="its directory cannot be created"; return 1; }
  if [ ! -e "$lock" ] && [ ! -L "$lock" ]; then
    tmp="$(mktemp "$dir/.$(basename "$lock").XXXXXX" 2>/dev/null)" ||
      { HOLD_LOCK_WHY="it cannot be created"; return 1; }
    chmod 0644 "$tmp" 2>/dev/null
    ln "$tmp" "$lock" 2>/dev/null
    rm -f "$tmp"
  fi
  if [ -L "$lock" ] || [ ! -f "$lock" ]; then HOLD_LOCK_WHY="it is not a regular file"; return 1; fi
  id="$(stat -c '%d:%i' -- "$lock" 2>/dev/null)" || { HOLD_LOCK_WHY="it cannot be inspected"; return 1; }
  # Read-only, so a lock made earlier still serves once its directory or the
  # file itself is no longer writable to this gate.
  { exec 3<"$lock"; } 2>/dev/null || { HOLD_LOCK_WHY="it cannot be opened"; return 1; }
  if [ "$(stat -L -c '%d:%i' /dev/fd/3 2>/dev/null)" != "$id" ] || [ -L "$lock" ] ||
     [ "$(stat -c '%d:%i' -- "$lock" 2>/dev/null)" != "$id" ]; then
    exec 3<&-; HOLD_LOCK_WHY="it changed while it was opened"; return 1
  fi
  flock -w "$wait" 3 || { exec 3<&-; HOLD_LOCK_WHY="it is held elsewhere past ${wait}s"; return 1; }
  if [ -L "$lock" ] || [ "$(stat -c '%d:%i' -- "$lock" 2>/dev/null)" != "$id" ]; then
    flock -u 3; exec 3<&-; HOLD_LOCK_WHY="it was replaced while this finish waited"; return 1
  fi
}

# Why a GO finish must leave the develop hold standing, or nothing when it may
# delete it. Kept: another run's HUMAN_DECISION hold (by verdict or by the
# needs_human_decision reason) unless the caller named exactly that run with
# --clear-hold; a hold that cannot be read or classified. Deleted as before:
# no hold, a NO_GO hold (a GO after a fix is how those clear), and the
# finishing run's own hold.
hold_clear_refusal() {  # <hold-file> <finishing-run-id> <clear-hold-run-id or "">
  local f="$1" run="$2" auth="$3" doc held
  [ -e "$f" ] || [ -L "$f" ] || return 0
  doc="$(jq -cs 'if length == 1 and (.[0] | type) == "object" and (.[0].runId | type) == "string" and .[0].runId != ""
                  then .[0] else error("not one hold record") end' "$f" 2>/dev/null)" || doc=""
  if [ -z "$doc" ]; then printf 'unreadable'; return 0; fi
  held="$(jq -r '.runId' <<<"$doc")"
  if [ "$(jq -r '.verdict == "HUMAN_DECISION" or .reason == "needs_human_decision"' <<<"$doc")" != true ]; then
    [ "$(jq -r '.verdict' <<<"$doc")" = NO_GO ] || printf 'unclassifiable'
    return 0
  fi
  [ "$held" = "$run" ] || [ "$held" = "$auth" ] || printf 'undispositioned'
}

hold_kept_record() {  # <hold-file> <reason> <clear-hold-run-id or "">
  jq -cn --arg why "$2" --arg auth "$3" \
    --arg held "$(jq -r 'if type == "object" then (.runId // empty) | strings else empty end' "$1" 2>/dev/null)" \
    '{reason:$why,runId:(if $held == "" then null else $held end),
      clearHoldFor:(if $auth == "" then null else $auth end)}'
}
