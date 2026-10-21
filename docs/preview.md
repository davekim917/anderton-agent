# Live app preview

An agent running a web app's dev server in its container shares a link to it. Anyone with the link opens the real,
running app in their own browser, hot reload included, while the agent keeps editing it.

## Flow

1. The agent starts its dev server inside the container on `127.0.0.1:<port>`, serving `/`.
2. It runs `ncl preview open --port <port> [--label <text>]`. The host picks a random id (128 bits, lowercase hex)
   and prints `https://<id>.$PREVIEW_ORIGIN_SUFFIX` and the expiry time. The agent posts that URL in its thread.
3. A browser opening the URL reaches the tunnel, which routes every `*.$PREVIEW_ORIGIN_SUFFIX` host to the host proxy
   on `127.0.0.1:$PREVIEW_PORT` (`src/modules/preview/proxy.ts`). The proxy reads the id from the `Host` header's
   first label and forwards the request, method, path, query, headers and body, to that container port. WebSocket
   upgrades (Vite's HMR) are forwarded the same way.
4. `ncl preview status` shows the session's open preview. The preview ends on `ncl preview close`, when the
   container exits, or 8 hours after it opened. A new `open` from the same session replaces the old one, and the old
   URL stops working at once.
5. While a preview is open, the session counts as active: the host withholds the chat idle reap and the stuck
   ceiling until the preview ends, for up to 8 hours (`heldAwakeUntilMs`). An agent should run `ncl preview close`
   as soon as nobody needs the app, or its container stays up for the rest of those 8 hours. A scheduled-task
   session is not held.

Previews live in host memory. A host restart ends them all; the agent opens a new one.

## What the app must do

- Listen on `127.0.0.1`, not `localhost`: Node can resolve `localhost` to `::1` only, which the bridge does not reach.
- Accept the preview host. Vite: `server.allowedHosts: ['.<suffix>']`. The proxy passes `Host` through unchanged.
- Run from a checkout under `/workspace/worktrees`. `/@fs/` paths anywhere else are refused (see Security model).
- Leave HMR on the page's own origin (Vite's default when `server.hmr` sets no port), so the browser connects to
  `wss://<id>.<suffix>`.

## Security model

- **The id is the credential.** There is no cookie and no button page: a cookie would be granted to whoever holds
  the URL, so it would add nothing. Anyone the URL reaches can use the app, so it is posted only where the app
  itself may be seen. An unknown or ended id answers 404 `No live preview at this address.`, the same as a host that
  is not exactly `<id>.<suffix>`.
- **No exposed port.** The proxy reaches the app over `docker exec` into the agent's own container
  (`src/modules/browser-takeover/bridge.ts`, shared with browser takeover). No other container can reach it. Upstream
  connections are kept alive between requests, since each one is a `docker exec`.
- **Ending a preview cuts what is open through it.** Close, replacement and expiry also end WebSockets and
  streaming responses already open on the old URL, not just new requests. Each preview holds at most 32 live
  WebSockets, since every one is its own `docker exec`; the next gets 503.
- **`/@fs/` reaches only the agent's checkouts.** `/@fs/<absolute path>` reads any file the app's `server.fs.allow`
  admits, and Vite's default admits the whole workspace root it detects. An agent container also mounts its group
  folder at `/workspace/agent` and live credentials under `/home/node`, so the proxy does not leave this to the app.
  Every `/@fs/` in a path, including after `/@id/`, must be followed by `/workspace/worktrees/`, where the container
  mounts its repository checkouts; anything else answers 403 `Preview serves files only from the agent's
checkouts.` pnpm resolves Vite's client and dependencies to the checkout's own `node_modules/.pnpm`, so a
  monorepo still loads. The proxy also refuses with 403 any path containing `..` or a backslash. Both rules apply
  after URL-decoding to a fixed point, so no encoding gets past them. Within the checkouts the app's own
  `server.fs.allow` still decides.
- **Only the opening session's container.** `open` resolves the calling session's running container. An agent cannot
  point a preview at another container or at the host.
- **Previews are same-site with each other.** Every preview is a sibling subdomain of one suffix, and with any other
  site under the same registrable domain. A preview page is agent-written code, so anything that trusts same-site
  requests must check `Origin`. The dashboard's state-changing routes and the takeover proxy both do. A suffix on a
  registrable domain of its own avoids the question.

## Setup

1. `.env`: `PREVIEW_ORIGIN_SUFFIX=preview.example.com` and, optionally, `PREVIEW_PORT` (default `3002`). Unset suffix
   means the feature is off and nothing listens.
2. DNS: a wildcard record `*.preview.example.com` pointing at the tunnel. On Cloudflare that is a proxied CNAME
   named `*.preview` with target `<tunnel-id>.cfargotunnel.com`. The edge certificate must cover the wildcard:
   Cloudflare's Universal SSL covers only first-level subdomains, so `<id>.preview.example.com` needs Total TLS, an
   advanced certificate for `*.preview.example.com`, or a custom one.
3. Tunnel ingress (cloudflared), above the catch-all rule:

   ```yaml
   - hostname: '*.preview.example.com'
     service: http://localhost:3002
   ```

4. Restart the host. The log shows `Preview proxy started` with the suffix and port. Check it with a request for an
   unknown id, which must answer 404:

   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' -H 'Host: ffffffffffffffffffffffffffffffff.preview.example.com' \
     http://127.0.0.1:3002/
   ```
