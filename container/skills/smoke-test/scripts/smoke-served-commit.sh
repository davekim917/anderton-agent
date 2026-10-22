# HTTPS only; whitespace would split the request line and a `#` fragment would
# swallow the cache buster.
commit_url_valid() {  # <url>
  [[ "$1" =~ ^https://[^[:space:]#]+$ ]]
}

# A CDN in front of a static site serves version.json from cache (Cloudflare on
# Render answers HIT for minutes and ignores a request no-cache header), so each
# read carries a unique query parameter to reach the origin.
commit_url_nocache() {  # <url> → the url with a unique cache-busting parameter
  local sep='?'
  case "$1" in *\?*) sep='&' ;; esac
  printf '%s%ssmoke_gate_nocache=%s' "$1" "$sep" "$(date +%s%N)"
}

commit_url_fetch() {  # <url>
  timeout 10 curl -fsS --max-time 10 -H 'Accept: application/json' "$(commit_url_nocache "$1")"
}

# The full 40-character commit a body names, or empty when it names none.
# Validated inside jq: `$(...)` strips trailing newlines and bash drops NULs, so
# a check after extraction would accept "abc1234\n" as abc1234. A 7-39
# character commit is <tip> when it prefixes it, else it is resolved through
# GitHub and kept only if the full SHA begins with it.
served_commit_sha() {  # <body-file> <tip, 40 hex or empty> <owner/repo or empty>
  local short full tip="${2:-}" repo="${3:-}"
  short="$(jq -rs 'if length == 1 and (.[0] | type) == "object" and (.[0].commit | type) == "string"
                     and (.[0].commit | ascii_downcase | explode
                          | length >= 7 and length <= 40 and all(.[]; (. >= 48 and . <= 57) or (. >= 97 and . <= 102)))
                   then .[0].commit | ascii_downcase else empty end' "$1" 2>/dev/null)"
  [[ "$short" =~ ^[0-9a-f]{7,40}$ ]] || return 0
  if [ "${#short}" -eq 40 ]; then printf '%s' "$short"; return 0; fi
  if [[ "$tip" =~ ^[0-9a-f]{40}$ ]] && [ "${tip#"$short"}" != "$tip" ]; then
    printf '%s' "$tip"; return 0
  fi
  [ -n "$repo" ] || return 0
  full="$(timeout 10 gh api "repos/$repo/commits/$short" --jq '.sha' 2>/dev/null)" || return 0
  [[ "$full" =~ ^[0-9a-f]{40}$ ]] && [ "${full#"$short"}" != "$full" ] && printf '%s' "$full"
  return 0
}
