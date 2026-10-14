# Credentials in a remote URL are stripped, since the answer is printed to a
# terminal: all of an http(s) userinfo (a token often sits in the user field,
# and Git also accepts a transport prefix such as `https::https://…`), and the
# password of any other scheme, whose user may be the login. A relative local
# origin is made absolute, because the person runs the printed command from
# another directory.
clone_url_of() {
  local url
  url="$(git -C "$1" remote get-url origin 2>/dev/null)" || return 0
  case "$url" in
    *://* | /*) ;;
    *)
      # Git reads a colon before the first slash as scp-style host:path.
      if [[ "${url%%/*}" != *:* ]]; then
        url="$(cd "$1" && realpath -m -- "$url")"
      fi
      ;;
  esac
  printf '%s' "$url" | sed -E -e 's#(https?://)[^/@]*@#\1#' -e 's#(://[^/:@]*):[^/@]*@#\1@#'
}
