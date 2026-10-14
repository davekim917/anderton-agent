#!/usr/bin/env bash
# verify-nanoclaw: boot an isolated second NanoClaw host beside the live one and drive it.
# Usage (each call stands alone; pass the run directory every time):
#   verify-nanoclaw.sh launch [<revision>]       -> prints RUN=<evidence dir>
#   verify-nanoclaw.sh doctor  <run-dir>
#   verify-nanoclaw.sh seed    <run-dir>
#   verify-nanoclaw.sh chat    <run-dir> <text>
#   verify-nanoclaw.sh restart <run-dir>
#   verify-nanoclaw.sh guard   <run-dir>
#   verify-nanoclaw.sh cleanup <run-dir>
set -euo pipefail

REAL_HOME="${HOME}"
PRIVATE_DIR="$REAL_HOME/.agents/skills/verify-nanoclaw"
EVIDENCE_ROOT="$PRIVATE_DIR/evidence"
LOCK="$PRIVATE_DIR/.inuse"
SCRATCH_ROOT="$REAL_HOME/scratch/verify-nanoclaw"
BINDING="github.com/davekim917/nanoclaw"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"

die() { echo "verify-nanoclaw: $*" >&2; exit 1; }
note() { echo "verify-nanoclaw: $*" >&2; }
slug_of() { printf '%s' "$1" | sha1sum | cut -c1-8; }
utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

st() { # <run> <key> -> value from the run's state file
  local line
  line="$(grep -E "^$2=" "$1/state" | tail -1)" || die "state key $2 missing in $1/state"
  printf '%s' "${line#*=}"
}
st_set() { printf '%s=%s\n' "$2" "$3" >>"$1/state"; }
stq() { { grep -E "^$2=" "$1/state" 2>/dev/null || true; } | tail -1 | cut -d= -f2-; } # empty when unset

check_binding() {
  local url
  url="$(git -C "$REPO" remote get-url origin)"
  url="${url#*://}"; url="${url#*@}"; url="${url/://}"; url="${url%.git}"
  [ "$url" = "$BINDING" ] || die "this checkout's origin is $url, not $BINDING; refusing"
}

live_checkout() { # <unit>
  local wd
  wd="$(systemctl show -p WorkingDirectory --value "$1" 2>/dev/null || true)"
  [ -n "$wd" ] || die "cannot read the live unit's WorkingDirectory ($1); set VERIFY_LIVE_UNIT"
  realpath "$wd"
}

live_env() { # <unit> <live checkout> <key> <default>: the unit's environment wins over .env, as in src/config.ts
  local v
  v="$( { systemctl show -p Environment --value "$1" 2>/dev/null | tr ' ' '\n' | grep -E "^$3=" || true; } | tail -1 | cut -d= -f2-)"
  [ -n "$v" ] || v="$( { grep -E "^$3=" "$2/.env" 2>/dev/null || true; } | tail -1 | cut -d= -f2-)"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "${v:-$4}"
}

host_env() { # <run> -> argv prefix that runs a command as the verify host sees the world
  local run="$1"
  printf '%s\0' env -i "PATH=$PATH" "HOME=$(st "$run" HOME_DIR)" "TMPDIR=$(st "$run" TMP_DIR)" "LANG=C.UTF-8" "TZ=UTC"
}
in_wt() { # <run> <cmd...>: run inside the worktree with the verify host's environment
  local run="$1"; shift
  local -a pre
  mapfile -d '' pre < <(host_env "$run")
  (cd "$(st "$run" WT)" && "${pre[@]}" "$@")
}

proc_start() { awk '{print $22}' "/proc/$1/stat" 2>/dev/null || true; } # start time in clock ticks, fixed for a PID's life
host_alive() { # <run>: the recorded host PID is still the process this run started
  local pid; pid="$(stq "$1" HOST_PID)"
  [ -n "$pid" ] && [ -n "$(stq "$1" HOST_START)" ] && [ "$(proc_start "$pid")" = "$(stq "$1" HOST_START)" ]
}

recorder_alive() { # <run>: the recorded docker-events PID is still the recorder this run started
  local pid; pid="$(stq "$1" EVENTS_PID)"
  [ -n "$pid" ] && [ -n "$(stq "$1" EVENTS_START)" ] && [ "$(proc_start "$pid")" = "$(stq "$1" EVENTS_START)" ]
}

own_slug_safe() { # <run>: the run's slug exists and is not the live install's
  local slug; slug="$(stq "$1" SLUG)"
  [ -n "$slug" ] && [ "$slug" != "$(stq "$1" LIVE_SLUG)" ] && [ "$slug" != "$(slug_of "$(stq "$1" LIVE_CHECKOUT)")" ]
}

image_tags() { docker images --format '{{.Repository}}:{{.Tag}}' | { grep -v '<none>' || true; } | sort -u; }
redact() { sed -E 's#(://)[^:/@" ]+:[^@/" ]+@#\1<redacted>@#g'; } # proxy URLs carry the agent's gateway token

label_counts() { docker ps --format '{{.Label "nanoclaw-install"}}' | sed 's/^$/(none)/' | sort | uniq -c | sort -rn; }

release_lock() { if [ -f "$LOCK" ] && [ "$(cat "$LOCK")" = "$1" ]; then rm -f "$LOCK"; fi; }

cmd_launch() {
  local rev="${1:-origin/main}" run id sha live live_slug wt vslug holder
  local port="${VERIFY_PORT:-3999}" unit="${VERIFY_LIVE_UNIT:-nanoclaw-v2}" onecli_url="${VERIFY_ONECLI_URL:-http://127.0.0.1:10254}" build_image="${VERIFY_BUILD_IMAGE:-0}"
  check_binding
  git -C "$REPO" fetch --quiet origin
  sha="$(git -C "$REPO" rev-parse --verify "$rev^{commit}")"
  live="$(live_checkout "$unit")"; live_slug="$(slug_of "$live")"
  mkdir -p "$EVIDENCE_ROOT"
  id="$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:9}-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
  run="$EVIDENCE_ROOT/$id"
  mkdir "$run" # fails if it exists
  : >"$run/state"
  st_set "$run" REVISION "$sha"
  st_set "$run" LIVE_UNIT "$unit"; st_set "$run" LIVE_CHECKOUT "$live"; st_set "$run" LIVE_SLUG "$live_slug"
  st_set "$run" PORT "$port"; st_set "$run" ONECLI_URL "$onecli_url"; st_set "$run" BUILD_IMAGE "$build_image"
  # Unlabelled containers the live fleet depends on; any stop of one during a run is live impact.
  st_set "$run" SHARED_CONTAINERS "$(live_env "$unit" "$live" ONECLI_GATEWAY_CONTAINER onecli) onecli-postgres"
  holder="${VERIFY_HOLDER:-$(whoami)@$(hostname)} $(utc)"
  if ! (set -o noclobber; printf '%s\n' "$holder" >"$LOCK") 2>/dev/null; then
    printf 'Refused: %s held by %s\n' "$LOCK" "$(cat "$LOCK" 2>/dev/null)" >"$run/record.md"
    die "another run holds $LOCK: $(cat "$LOCK" 2>/dev/null). Wait for it; replace it only once its holder is confirmed gone."
  fi
  st_set "$run" HOLDER "$holder"
  # From here every exit that is not success runs the full cleanup, which also releases the lock.
  # shellcheck disable=SC2064 # the run directory is fixed now, so it is expanded into the trap here.
  trap "rc=\$?; trap - EXIT; if [ \"\$rc\" != 0 ]; then note \"launch failed (exit \$rc); cleaning up $run\"; ( cmd_cleanup '$run' ) || true; fi; exit \"\$rc\"" EXIT
  st_set "$run" LIVE_MAINPID "$(systemctl show -p MainPID --value "$unit")"
  st_set "$run" LIVE_LOG_OFFSET "$(stat -c %s "$live/logs/nanoclaw.log" 2>/dev/null || echo 0)"
  label_counts >"$run/labels-before.txt"
  image_tags >"$run/images-before.txt"
  onecli agents list --quiet identifier --max 1000 | sort >"$run/onecli-agents-before.txt"
  local scratch="$SCRATCH_ROOT/$id"
  mkdir -p "$scratch/home" "$scratch/tmp"
  wt="$scratch/wt"
  st_set "$run" SCRATCH "$scratch"; st_set "$run" WT "$wt"
  st_set "$run" HOME_DIR "$scratch/home"; st_set "$run" TMP_DIR "$scratch/tmp"
  git -C "$REPO" worktree add --quiet --detach "$wt" "$sha"
  wt="$(realpath "$wt")"
  vslug="$(slug_of "$wt")"
  [ "$wt" != "$live" ] && [ "$vslug" != "$live_slug" ] || die "worktree resolves to the live checkout (slug $vslug); refusing"
  st_set "$run" SLUG "$vslug"
  # Recorded before anything touches docker, so guard can attribute every container event during the run.
  docker events --filter type=container --filter type=image \
    --format '{{.TimeNano}} {{.Type}} {{.Action}} {{.Actor.Attributes.name}} install={{index .Actor.Attributes "nanoclaw-install"}}' \
    </dev/null >"$run/docker-events.log" 2>&1 &
  echo $! >"$run/docker-events.pid"
  st_set "$run" EVENTS_PID "$!"; st_set "$run" EVENTS_START "$(proc_start "$!")"
  note "installing and building $sha in $wt (niced)"
  (cd "$wt" && ionice -c3 nice -n 10 pnpm install --frozen-lockfile --offline) >"$run/install.log" 2>&1
  # The build refuses any HEAD but origin/main; a PR head is a legitimate target here, and doctor checks BUILD_INFO names it.
  (cd "$wt" && BUILD_ALLOW_LOCAL=1 ionice -c3 nice -n 10 pnpm run build) >"$run/build.log" 2>&1
  ensure_image "$run"
  cat >"$wt/.env" <<EOF
WEBHOOK_PORT=$port
ONECLI_URL=$onecli_url
NANOCLAW_ONECLI_APPROVALS=0
NANOCLAW_STORAGE_MANAGER_ENABLED=0
MAX_CONCURRENT_CONTAINERS=1
CONTAINER_MEMORY_LIMIT=1g
BACKLOG_CANVAS_ENABLED=0
DAILY_SUMMARY_ENABLED=0
TZ=UTC
EOF
  chmod 600 "$wt/.env"
  # A secured gateway needs the live install's key; it stays in the scratch worktree, never in evidence.
  grep -E '^ONECLI_API_KEY=' "$live/.env" >>"$wt/.env" 2>/dev/null || true
  in_wt "$run" node_modules/.bin/tsx scripts/upgrade-state.ts set >>"$run/install.log" 2>&1
  cmd_doctor_preboot "$run"
  start_host "$run" host.log
  trap - EXIT
  echo "RUN=$run"
}

ensure_image() {
  local run="$1" wt vimg limg want have
  wt="$(st "$run" WT)"
  vimg="nanoclaw-agent-v2-$(st "$run" SLUG):latest"
  limg="nanoclaw-agent-v2-$(st "$run" LIVE_SLUG):latest"
  want="$(printf '%s%s' "$(sha256sum "$wt/container/agent-runner/package.json" | awk '{print $1}')" \
    "$(sha256sum "$wt/container/agent-runner/bun.lock" | awk '{print $1}')" | sha256sum | cut -c1-16)"
  st_set "$run" IMAGE "$vimg"
  if docker image inspect "$vimg" >/dev/null 2>&1; then st_set "$run" IMAGE_TAGGED_BY_RUN 0; return; fi
  have="$(docker image inspect --format '{{index .Config.Labels "nanoclaw.agentRunnerDepsHash"}}' "$limg" 2>/dev/null || true)"
  if [ "$have" = "$want" ]; then
    docker tag "$limg" "$vimg"
    st_set "$run" IMAGE_TAGGED_BY_RUN 1
    st_set "$run" IMAGE_SOURCE "tag of $limg ($(docker image inspect --format '{{.Id}}' "$limg"))"
  else
    [ "$(st "$run" BUILD_IMAGE)" = 1 ] || die "runner deps differ from $limg (want $want, have ${have:-none}); rerun with VERIFY_BUILD_IMAGE=1 to build $vimg"
    st_set "$run" IMAGE_TAGGED_BY_RUN 1
    (cd "$wt" && CONTAINER_IMAGE_REF="$vimg" ionice -c3 nice -n 10 ./container/build.sh) >"$run/image-build.log" 2>&1
    st_set "$run" IMAGE_SOURCE "built by this run"
  fi
}

start_host() {
  local run="$1" log="$2" pid i
  local -a pre
  mapfile -d '' pre < <(host_env "$run")
  # exec keeps the recorded PID the node process itself, and nothing inherits the caller's stdout.
  (cd "$(st "$run" WT)" && exec setsid "${pre[@]}" ionice -c3 nice -n 10 node dist/index.js) </dev/null >>"$run/$log" 2>&1 &
  pid=$!
  echo "$pid" >"$run/host.pid"
  st_set "$run" HOST_PID "$pid"
  st_set "$run" HOST_START "$(proc_start "$pid")"
  for i in $(seq 1 90); do
    host_alive "$run" || die "host exited during boot; see $run/$log"
    if in_wt "$run" node_modules/.bin/tsx src/cli/client.ts groups list >/dev/null 2>&1; then
      note "host ready (pid $pid) after ~$((i * 2))s"; return 0
    fi
    sleep 2
  done
  die "host not ready after 180s; see $run/$log"
}

cmd_doctor_preboot() {
  local run="$1" wt live_port
  check_binding
  wt="$(st "$run" WT)"
  [ "$(realpath "$wt")" != "$(st "$run" LIVE_CHECKOUT)" ] || die "doctor: worktree is the live checkout"
  [ "$(slug_of "$(realpath "$wt")")" = "$(st "$run" SLUG)" ] || die "doctor: slug changed"
  own_slug_safe "$run" || die "doctor: slug equals the live slug"
  ! grep -qE '^(SLACK|DISCORD)_' "$wt/.env" || die "doctor: channel tokens in $wt/.env"
  grep -qx 'NANOCLAW_ONECLI_APPROVALS=0' "$wt/.env" || die "doctor: .env does not keep the host off the OneCLI approval queue"
  grep -qx 'NANOCLAW_STORAGE_MANAGER_ENABLED=0' "$wt/.env" || die "doctor: .env does not disable the storage manager"
  grep -q '^HOST_PID=' "$run/state" || [ ! -e "$wt/data/v2.db" ] || die "doctor: data/v2.db exists before first boot (data must start empty)"
  live_port="$(grep -E '^WEBHOOK_PORT=' "$(st "$run" LIVE_CHECKOUT)/.env" | cut -d= -f2 || true)"
  [ "$(st "$run" PORT)" != "${live_port:-3000}" ] || die "doctor: port $(st "$run" PORT) is the live port"
  [ "$(node -p "require(process.argv[1]).sha" "$wt/dist/BUILD_INFO.json")" = "$(git -C "$wt" rev-parse HEAD)" ] \
    || die "doctor: dist/BUILD_INFO.json does not name the worktree HEAD"
  docker image inspect "$(st "$run" IMAGE)" >/dev/null || die "doctor: image $(st "$run" IMAGE) missing"
  # The .env lines above are inert in a build that does not read them, so the build itself must carry both switches.
  { grep -qF 'NANOCLAW_ONECLI_APPROVALS' "$wt/dist/config.js" && grep -qF 'ONECLI_APPROVALS_ENABLED' "$wt/dist/modules/approvals/onecli-approvals.js"; } 2>/dev/null \
    || die "doctor: this revision predates NANOCLAW_ONECLI_APPROVALS; booting it would poll the fleet's OneCLI approval queue"
  grep -qF 'NANOCLAW_STORAGE_MANAGER_ENABLED' "$wt/dist/storage-manager.js" 2>/dev/null \
    || die "doctor: this revision does not read NANOCLAW_STORAGE_MANAGER_ENABLED; booting it would run storage passes on the shared daemon"
}

cmd_doctor() {
  local run="$1" pid port
  cmd_doctor_preboot "$run"
  pid="$(st "$run" HOST_PID)"; port="$(st "$run" PORT)"
  host_alive "$run" || die "doctor: host pid $pid is not the process this run started"
  tr '\0' '\n' <"/proc/$pid/environ" | grep -qx "HOME=$(st "$run" HOME_DIR)" || die "doctor: host HOME is not the scratch home"
  tr '\0' '\n' <"/proc/$pid/environ" | grep -qx "TMPDIR=$(st "$run" TMP_DIR)" || die "doctor: host TMPDIR is not scratch"
  ss -ltnpH "sport = :$port" | grep -q "pid=$pid," || die "doctor: port $port is not owned by host pid $pid"
  ! grep -qF 'OneCLI approval handler started' "$run"/host*.log || die "doctor: the host is polling the shared OneCLI approval queue"
  ! grep -qF 'storage-manager: maintenance complete' "$run"/host*.log || die "doctor: the storage manager ran"
  in_wt "$run" node_modules/.bin/tsx src/cli/client.ts groups list >/dev/null || die "doctor: ncl does not answer"
  [ "$(systemctl show -p MainPID --value "$(st "$run" LIVE_UNIT)")" = "$(st "$run" LIVE_MAINPID)" ] \
    || note "doctor: live MainPID changed since launch (live restarted?)"
  echo "doctor: ok (slug $(st "$run" SLUG), pid $pid, port $port, image $(st "$run" IMAGE))"
}

cmd_seed() {
  local run="$1" wt out ag folder=verify-cli
  wt="$(st "$run" WT)"
  out="$(in_wt "$run" node_modules/.bin/tsx scripts/init-cli-agent.ts --display-name "Verify Operator" --agent-name Verify --folder "$folder")"
  printf '%s\n' "$out" >>"$run/seed.txt"
  ag="$(printf '%s\n' "$out" | sed -n 's/.*agent: .*\[\(ag-[^]]*\)\].*/\1/p' | head -1)"
  [ -n "$ag" ] || die "seed: could not read the agent group id; see $run/seed.txt"
  grep -qx "$ag" "$run/onecli-agents-before.txt" && die "seed: $ag already exists in the OneCLI vault"
  [ "$(stq "$run" AGENT_GROUP)" = "$ag" ] || st_set "$run" AGENT_GROUP "$ag"
  # init-cli-agent writes no container.json and no container_configs row; the spawn path reads container.json
  # (absent = the install default provider), so the provider is set there before the first spawn. The mock cannot
  # call send_message, so outcome reporting goes off or its final text stays an internal work_log.
  node -e 'const fs=require("fs"),p=process.argv[1];const c=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,"utf8")):{};c.provider="mock";c.outcomeReporting=false;fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n")' \
    "$wt/groups/$folder/container.json"
  cp "$wt/groups/$folder/container.json" "$run/container.json"
  if [ -n "$(docker ps -q --filter "label=nanoclaw-install=$(st "$run" SLUG)")" ]; then
    in_wt "$run" node_modules/.bin/tsx src/cli/client.ts groups restart --id "$ag" >>"$run/seed.txt" 2>&1 \
      || die "seed: a container is already running and ncl groups restart failed; see $run/seed.txt"
  fi
  echo "seed: $ag provider=mock outcomeReporting=false"
}

cmd_chat() {
  local run="$1" text="$2" rc=0 ag sess n=1 c
  while [ -e "$run/chat-$n.exit" ]; do n=$((n + 1)); done
  in_wt "$run" timeout 150 node_modules/.bin/tsx scripts/chat.ts "$text" >"$run/chat-$n.stdout" 2>"$run/chat-$n.stderr" || rc=$?
  printf '%s\n' "$text" >"$run/chat-$n.sent"
  echo "$rc" >"$run/chat-$n.exit"
  ag="$(st "$run" AGENT_GROUP)"
  for sess in "$(st "$run" WT)/data/v2-sessions/$ag"/*/; do
    [ -f "$sess/inbound.db" ] || continue
    {
      echo "## $(basename "$sess") inbound messages_in"
      in_wt "$run" node_modules/.bin/tsx scripts/q.ts "$sess/inbound.db" "select seq, kind, status, substr(content,1,300) from messages_in order by seq" || echo "(query failed: exit $?)"
      echo "## delivered"
      in_wt "$run" node_modules/.bin/tsx scripts/q.ts "$sess/inbound.db" "select * from delivered" || echo "(query failed: exit $?)"
      echo "## outbound messages_out"
      in_wt "$run" node_modules/.bin/tsx scripts/q.ts "$sess/outbound.db" "select seq, kind, substr(content,1,300) from messages_out order by seq" || echo "(query failed: exit $?)"
    } >>"$run/session-db-$n.txt" 2>&1
  done
  for c in $(docker ps -a --filter "label=nanoclaw-install=$(st "$run" SLUG)" --format '{{.Names}}' || echo); do
    (umask 077; docker inspect "$c" | redact >"$run/container-$c-$n.json") || note "chat: docker inspect $c failed"
    docker inspect --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' "$c" >"$run/container-$c-$n.mounts.txt" || note "chat: mount listing for $c failed"
  done
  cat "$run/chat-$n.stdout"
  [ "$rc" = 0 ] || die "chat $n exited $rc; see $run/chat-$n.stderr"
}

cmd_restart() {
  local run="$1" pid i
  pid="$(st "$run" HOST_PID)"
  host_alive "$run" || die "restart: host pid $pid is not the process this run started"
  kill -TERM "$pid"
  for i in $(seq 1 60); do host_alive "$run" || break; sleep 1; done
  ! host_alive "$run" || die "host $pid did not exit after SIGTERM"
  docker ps --filter "label=nanoclaw-install=$(st "$run" SLUG)" --format '{{.Names}}' >"$run/containers-across-restart.txt"
  start_host "$run" host-restart.log
  grep -h 'Reconciled sessions at startup' "$run/host-restart.log" | tail -1
}

cmd_guard() { # exit 3 when this run touched a container that is not its own, or shared infrastructure stopped
  local run="$1" own own_image live_log live_slug name type action install shared shared_list now_tags bad=0 by_live=0 unattributed=0 other=0
  own="$(st "$run" SLUG)"; live_slug="$(st "$run" LIVE_SLUG)"
  shared_list="$(stq "$run" SHARED_CONTAINERS)"; shared_list="${shared_list:-onecli onecli-postgres}"
  live_log="$run/.guard-live-window.log"
  tail -c +"$(( $(st "$run" LIVE_LOG_OFFSET) + 1 ))" "$(st "$run" LIVE_CHECKOUT)/logs/nanoclaw.log" >"$live_log" 2>/dev/null || true
  own_image="$(stq "$run" IMAGE)"
  while read -r _ type action name install; do
    install="${install#install=}"
    if [ "$type" = image ]; then
      if { [ "$action" = untag ] || [ "$action" = delete ]; } && [ "$name" != "$own_image" ] && [[ "$name" == *:* ]] && [[ "$name" != sha256:* ]]; then
        echo "guard: VIOLATION: image $name got $action during the run"; bad=1
      fi
      continue
    fi
    [ "$action" = stop ] || [ "$action" = kill ] || continue
    [ "$install" = "$own" ] && continue
    if grep -qF -- "$name" "$run"/host*.log 2>/dev/null; then
      echo "guard: VIOLATION: the verify host log names non-own container $name ($action, install=$install)"; bad=1
    elif [ "$install" = "$live_slug" ]; then
      # A later "Container exited" line names a container whoever stopped it; only the host's stop records count.
      if awk -v n="$name" 'index($0, n) && (index($0, "Killing container") || index($0, "Container stopped by host")) { f = 1 } END { exit !f }' "$live_log"; then
        by_live=$((by_live + 1))
      else
        echo "guard: UNATTRIBUTED: live container $name got $action and the live host log has no stop record for it"; unattributed=$((unattributed + 1)); bad=1
      fi
    else
      for shared in $shared_list; do
        if [ "$name" = "$shared" ]; then echo "guard: LIVE IMPACT: shared container $name got $action during the run"; bad=1; fi
      done
      other=$((other + 1))
    fi
  done <"$run/docker-events.log"
  rm -f "$live_log"
  if grep -qvE '^[0-9]+ (container|image) [^ ]' "$run/docker-events.log"; then
    echo "guard: VIOLATION: the event recorder logged something other than an event: $(grep -vE '^[0-9]+ (container|image) [^ ]' "$run/docker-events.log" | head -1)"; bad=1
  fi
  # Untag and delete events can name an image by ID alone, so the tag inventory is the check that cannot miss one.
  if [ ! -f "$run/images-before.txt" ]; then
    echo "guard: VIOLATION: no image inventory was recorded at launch"; bad=1
  elif now_tags="$(cat "$run/images-after.txt" 2>/dev/null || image_tags)"; then
    while read -r tag; do
      [ -n "$tag" ] && [ "$tag" != "$own_image" ] || continue
      grep -qxF -- "$tag" <<<"$now_tags" || { echo "guard: VIOLATION: image tag $tag present at launch is gone"; bad=1; }
    done <"$run/images-before.txt"
  else
    echo "guard: VIOLATION: could not list images"; bad=1
  fi
  if [ "$(stq "$run" EVENTS_STOPPED)" != 1 ] && ! recorder_alive "$run"; then
    echo "guard: VIOLATION: the event recorder is not running and cleanup did not stop it; nothing after its last line was audited"; bad=1
  fi
  if grep -qE 'Stopped an unadoptable|duplicate container|Stopped orphaned containers' "$run"/host*.log 2>/dev/null; then
    echo "guard: VIOLATION: the verify host stopped a container at boot"; bad=1
  fi
  echo "guard: live stop/kill events with the live host's own stop record: $by_live; unattributed: $unattributed; other installs or unlabelled: $other"
  [ "$bad" = 0 ] || exit 3
  echo "guard: ok"
}

cmd_cleanup() { # every step runs whatever an earlier one did; exits non-zero if guard or a step failed
  local run="$1" pid c ag uuid i slug failed=0 guard_rc=0 wt scratch
  : >"$run/cleanup.txt"
  step() { if "$@"; then echo "ok: $*" >>"$run/cleanup.txt"; else echo "FAILED: $*" >>"$run/cleanup.txt"; note "cleanup step failed: $*"; failed=1; fi; }
  lost() { echo "FAILED: $*" >>"$run/cleanup.txt"; note "cleanup: $*"; failed=1; }
  pid="$(stq "$run" HOST_PID)"
  if host_alive "$run"; then
    step kill -TERM "$pid"
    for i in $(seq 1 60); do host_alive "$run" || break; sleep 1; done
    if host_alive "$run"; then step kill -KILL "$pid"; fi
  fi
  # The host leaves containers for the next host to adopt; stop this install's by label, never by name prefix.
  slug="$(stq "$run" SLUG)"
  if own_slug_safe "$run"; then
    local ids
    if ids="$(docker ps -q --filter "label=nanoclaw-install=$slug")"; then
      for c in $ids; do step docker stop -t 5 "$c"; done
    else
      lost "could not list this install's containers; some may still be running"
    fi
  elif [ -n "$slug" ]; then
    lost "slug $slug is the live install's; stopped nothing"
  fi
  ag="$(stq "$run" AGENT_GROUP)"
  if [ -n "$ag" ]; then
    local agents
    if agents="$(onecli agents list --fields id,identifier --max 1000 2>/dev/null)" && uuid="$(printf '%s' "$agents" | node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const l=JSON.parse(s);if(!Array.isArray(l))process.exit(2);const a=l.find(x=>x.identifier===process.argv[1]);process.stdout.write(a?a.id:"")})' "$ag")"; then
      if [ -n "$uuid" ] && ! onecli agents delete --id "$uuid" >"$run/onecli-delete.txt" 2>&1; then
        lost "ONECLI AGENT NOT DELETED: $ag ($uuid) is still in the shared gateway with a live token; delete it by hand (see onecli-delete.txt)"
      fi
    else
      lost "ONECLI AGENT MAY REMAIN: could not list OneCLI agents; check for $ag in the shared gateway and delete it by hand"
    fi
  fi
  if [ "$(stq "$run" IMAGE_TAGGED_BY_RUN)" = 1 ] && docker image inspect "$(stq "$run" IMAGE)" >/dev/null 2>&1; then
    step docker rmi "$(stq "$run" IMAGE)"
  fi
  if recorder_alive "$run"; then
    step kill "$(stq "$run" EVENTS_PID)"
    for i in $(seq 1 10); do recorder_alive "$run" || break; sleep 1; done
    if recorder_alive "$run"; then lost "the docker-events recorder did not exit"; else st_set "$run" EVENTS_STOPPED 1; fi
  elif [ -n "$(stq "$run" EVENTS_PID)" ]; then
    lost "the docker-events recorder died before cleanup; the run is unaudited after its last event"
  fi
  label_counts >"$run/labels-after.txt" 2>&1 || true
  image_tags >"$run/images-after.txt" 2>/dev/null || rm -f "$run/images-after.txt"
  onecli agents list --quiet identifier --max 1000 2>/dev/null | sort >"$run/onecli-agents-after.txt" || true
  {
    echo "live MainPID at launch: $(stq "$run" LIVE_MAINPID); now: $(systemctl show -p MainPID --value "$(stq "$run" LIVE_UNIT)" 2>/dev/null)"
    echo "live log lines since launch naming this install's slug:"
    if [ -n "$slug" ]; then
      tail -c +"$(( $(stq "$run" LIVE_LOG_OFFSET) + 1 ))" "$(stq "$run" LIVE_CHECKOUT)/logs/nanoclaw.log" 2>/dev/null | grep -cF "$slug" || true
    fi
  } >"$run/live-after.txt"
  if [ -f "$run/docker-events.log" ]; then ( cmd_guard "$run" ) >"$run/guard.txt" 2>&1 || guard_rc=$?; fi
  wt="$(stq "$run" WT)"; scratch="$(stq "$run" SCRATCH)"
  if [ -n "$wt" ] && [ -d "$wt" ]; then step git -C "$REPO" worktree remove --force "$wt"; fi
  case "$scratch" in "$SCRATCH_ROOT"/?*) step rm -rf "$scratch" ;; esac
  release_lock "$(stq "$run" HOLDER)"
  echo "cleanup: done; evidence kept at $run"
  if [ "$guard_rc" != 0 ]; then cat "$run/guard.txt" >&2; exit "$guard_rc"; fi
  [ "$failed" = 0 ] || die "cleanup: one or more steps failed; see $run/cleanup.txt"
}

sub="${1:-}"; shift || true
case "$sub" in
  launch) cmd_launch "$@" ;;
  doctor) cmd_doctor "$@" ;;
  seed) cmd_seed "$@" ;;
  chat) cmd_chat "$@" ;;
  restart) cmd_restart "$@" ;;
  guard) cmd_guard "$@" ;;
  cleanup) cmd_cleanup "$@" ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
