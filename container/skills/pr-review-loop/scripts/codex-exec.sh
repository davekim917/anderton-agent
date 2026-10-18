#!/usr/bin/env bash
# `codex exec`, rerun once on the next Codex account when the first is at its
# usage limit.
#
#   codex-exec.sh [--prompt-file <file>] [--] <codex exec arguments…>
#
# stdout is the final attempt's only; stderr ends with `codex-exec:
# account=<CODEX_HOME> exit=<n>`. stdin is closed, because an open stdin makes
# codex wait for more prompt; --prompt-file feeds a file instead.
#
# Accounts: the current one is $CODEX_HOME, else ~/.codex. The rerun uses the
# first of ~/.codex-fallback-<n> (a container's staged fallbacks, in order) or
# ~/.codex-secondary that holds an auth.json and under which codex's hooks/list
# reports every hook it dispatches under the current home. Hook trust is keyed on
# each home's own hooks.json path, and a container stages a fallback as a bare
# credential, so a home can hold the same files and still run without the
# guards. Pass -m explicitly: a fallback may carry no config.toml.
#
# Exit: codex's own exit code, or 13 when the last attempt also hit the usage
# limit or no usable fallback account exists (the same meaning as `codex-review.sh
# wait` exit 13: use a non-Codex frontier reviewer).
set -uo pipefail

prompt_file=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prompt-file)
      [ $# -ge 2 ] || { echo "codex-exec: --prompt-file needs a file" >&2; exit 2; }
      prompt_file="$2"; shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
if [ -n "$prompt_file" ] && [ ! -r "$prompt_file" ]; then
  echo "codex-exec: cannot read --prompt-file $prompt_file" >&2
  exit 2
fi

# codex prints a failed turn as `ERROR: <message>` on stderr and exits 1; the
# prompt is echoed to stderr too, so only an ERROR line counts. Every usage-limit
# sentence in the codex CLI starts "You've hit your usage limit".
usage_limited() {
  sed $'s/\x1b\\[[0-9;]*m//g' "$1" | grep -q -E '^ERROR: .*hit your usage limit'
}

work=$(mktemp -d) || exit 1
trap 'rm -rf "$work"' EXIT

attempt() {
  local home="$1" stdin_src=/dev/null
  shift
  [ -n "$prompt_file" ] && stdin_src="$prompt_file"
  CODEX_HOME="$home" codex exec "$@" <"$stdin_src" 2>&1 >"$work/out" | tee "$work/err" >&2
  return "${PIPESTATUS[0]}"
}

probe_args=()
probe_reproducible=1
scan_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --) return 0 ;;
      -c|--config|--enable|--disable)
        [ $# -ge 2 ] || { probe_reproducible=0; return 0; }
        probe_args+=("$1" "$2"); shift 2 ;;
      --config=*|--enable=*|--disable=*|--strict-config) probe_args+=("$1"); shift ;;
      -m|--model|-s|--sandbox|-i|--image|-o|--output-last-message|--output-schema|--color)
        [ $# -ge 2 ] || { probe_reproducible=0; return 0; }
        shift 2 ;;
      --model=*|--sandbox=*|--image=*|--output-last-message=*|--output-schema=*|--color=*|--skip-git-repo-check|--ephemeral) shift ;;
      --json) echo "codex-exec: --json moves codex's errors to stdout, where the usage-limit check does not look; run without it" >&2; exit 2 ;;
      -*) probe_reproducible=0; shift ;;
      *) shift ;;
    esac
  done
}
scan_args "$@"

hook_set() {
  local js
  [ "$probe_reproducible" -eq 1 ] || return 1
  js=$(command -v node || command -v bun) || return 1
  "$js" "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/codex-hook-set.mjs" "$1" "${probe_args[@]}"
}

same_guard_chain() {
  local current_hooks candidate_hooks
  current_hooks=$(hook_set "$1") || return 1
  candidate_hooks=$(hook_set "$2") || return 1
  [ -z "$(LC_ALL=C comm -23 <(printf '%s\n' "$current_hooks" | sed '/^$/d' | LC_ALL=C sort) <(printf '%s\n' "$candidate_hooks" | sed '/^$/d' | LC_ALL=C sort))" ]
}

fallback_home() {
  local current="$1" candidate n=1 unguarded=0
  local candidates=()
  while [ -d "$HOME/.codex-fallback-$n" ]; do
    candidates+=("$HOME/.codex-fallback-$n")
    n=$((n + 1))
  done
  candidates+=("$HOME/.codex-secondary")
  for candidate in "${candidates[@]}"; do
    [ ! "$candidate" -ef "$current" ] && [ -f "$candidate/auth.json" ] || continue
    if ! same_guard_chain "$current" "$candidate"; then
      unguarded=1
      continue
    fi
    printf '%s\n' "$candidate"
    return 0
  done
  [ "$unguarded" -eq 1 ] && return 3
  return 1
}

finish() {
  cat "$work/out"
  echo "codex-exec: account=$1 exit=$2" >&2
  exit "$2"
}

current="${CODEX_HOME:-$HOME/.codex}"
attempt "$current" "$@"
rc=$?
if [ "$rc" -eq 0 ] || ! usage_limited "$work/err"; then
  finish "$current" "$rc"
fi
next=$(fallback_home "$current")
case $? in
  0) ;;
  3)
    echo "codex-exec: $current hit its Codex usage limit; no fallback account here is confirmed to dispatch every hook $current does, so none is used; use a non-Codex frontier reviewer" >&2
    finish "$current" 13 ;;
  *)
    echo "codex-exec: $current hit its Codex usage limit and no fallback account has an auth.json (~/.codex-fallback-<n>, ~/.codex-secondary); use a non-Codex frontier reviewer" >&2
    finish "$current" 13 ;;
esac
echo "codex-exec: $current hit its Codex usage limit; rerunning once with CODEX_HOME=$next" >&2
attempt "$next" "$@"
rc=$?
if [ "$rc" -ne 0 ] && usage_limited "$work/err"; then
  echo "codex-exec: $current and $next are both at their Codex usage limit; use a non-Codex frontier reviewer" >&2
  finish "$next" 13
fi
finish "$next" "$rc"
