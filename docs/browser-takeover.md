# Browser takeover

An agent that hits a sign-in it cannot do (SSO, MFA, a CAPTCHA) asks an owner to sign in for it. The owner signs in to a
throwaway **sidecar** browser the agent cannot reach; only the resulting session state is handed to the agent. The
password never enters the agent's container, chat, or the host.

## Flow

1. The agent runs `ncl browser takeover --url <the app's page> --site <name>`; the app redirects through its SSO.
2. The host starts a sidecar from the agent container's image (no mounts, no secrets: its only env is the two browser-launch settings below, `--memory 1g`, `sleep` bounding its
   life to the link plus binding TTLs, so it removes itself even past a host restart), opens the URL in it, starts its
   agent-browser dashboard with `--allowed-origins $BROWSER_TAKEOVER_ORIGIN`, and DMs an owner or global admin
   (`notifyOperators`) a one-time link, `$BROWSER_TAKEOVER_ORIGIN/t/<token>`, valid 30 minutes.
3. Opening the link shows one button (a GET spends nothing, so link unfurlers and safe-link scanners cannot burn it).
   Pressing it POSTs, which sets an HttpOnly `__Host-` cookie binding that browser to the sidecar for 2 hours and
   redirects to the viewer page (`src/modules/browser-takeover/viewer.ts`). The sidecar runs at a phone-width viewport
   (430×900). The owner taps the live view to click, drags to scroll, and types in the page's text box, which brings
   up a phone keyboard; its edits are replayed as keystrokes into whatever field they tapped.
4. The owner replies in the agent's conversation. The agent runs `ncl browser finish`: the host saves the sidecar's
   session (`agent-browser state save`), keeping only cookies the browser would send to the `--url` host and that
   origin's storage, to `data/browser-state/<workgroup>/<site>.json`
   (0600) and removes the sidecar. The agent `state load`s `/workspace/browser-state/<site>.json`.

A new takeover from the same session replaces the open one. Links, bindings and sidecars are tracked in host memory: a
host restart ends them (the sidecar still exits on its own).

## Sign-in pages that detect automation

Google sign-in and reCAPTCHA refuse a browser that reports itself automated, so the sidecar's Chromium runs with
`--disable-blink-features=AutomationControlled` (no `navigator.webdriver`) and a plain Chrome user agent for the
image's Chromium version (no `HeadlessChrome`). That does not change the host's datacenter IP, which reCAPTCHA also
scores; a site that still refuses needs another route (a session handed over from the owner's own browser, or a
browser with a residential IP).

## Security model

- **The agent never touches the browser the owner types into.** Typing into the agent's own browser would expose the
  password to the agent's code (`eval` on the field, network capture), and an SSO password unlocks far more than one
  app.
- **Only the app's session leaves the sidecar.** Signing in through SSO also leaves the identity provider's session
  in the sidecar, which would open every app behind that SSO; it is dropped at export. Where the app and the identity
  provider share a domain (Google's own apps on `google.com`), the domain filter cannot separate them, so do not
  hand those over this way.
- **The owner checks the host.** The agent picks `--url`; the DM names its host, and a lookalike host is a phishing
  attempt to refuse.
- **Separate origin.** The dashboard is container-served code that expects to own `/`. On the board's origin it
  could call the board API with the owner's cookie, so it gets its own hostname.
- **No exposed port.** The dashboard binds the sidecar's loopback. The host proxy (`127.0.0.1:$BROWSER_TAKEOVER_PORT`)
  reaches it over `docker exec` (`src/modules/browser-takeover/bridge.ts`), so no other container can.
- **Viewing and input only.** The proxy forwards exactly two requests to the sidecar's agent-browser dashboard: a GET
  of `/api/sessions` and the GET upgrade of `/api/session/<port>/stream`. Everything else the dashboard serves,
  including its UI and its POST routes (`/api/exec` runs arbitrary agent-browser commands), answers 404 or 405.
- **The dashboard token stays on the host.** The proxy presents it upstream as the dashboard's cookie, with the
  `Origin` the dashboard requires; the viewer's browser holds only the binding cookie.
- **Coupled to agent-browser's stream protocol.** agent-browser's own dashboard UI handles only mouse events and
  keys typed into a focused canvas, so a phone can neither tap nor type in it; the viewer speaks the stream's
  messages itself (`frame`, `status`, `input_mouse`, `input_keyboard`). An agent-browser bump can change them.
  `viewer.test.ts` pins `AGENT_BROWSER_VERSION`, so a bump fails until someone runs a takeover on a phone (the
  page streams, a tap clicks, typing lands in a field, a drag scrolls) and moves the pin.
- **The proxy checks which page is asking.** It presents the trusted origin upstream, so the dashboard's own origin
  check no longer tells pages apart; the proxy refuses a stream upgrade whose browser `Origin` is not
  `BROWSER_TAKEOVER_ORIGIN`, and a session-list fetch marked cross-origin. A sibling page under the same domain would
  otherwise carry the binding cookie into the live view.
- **Saved logins are credentials at rest.** `data/browser-state/<workgroup>/` (0700, outside git and outside the
  workgroup shared tree) is mounted read-write at `/workspace/browser-state` into every member of the workgroup.
  Anyone who can read a file there can act as whoever signed in until the site expires the session. Delete the file to
  stop handing it out; sign the session out at the site to kill it everywhere. Prefer a least-privilege account for
  the agent over an owner's own login.

## Setup

Takeover is refused while `NANOCLAW_EGRESS_LOCKDOWN=true`: the sidecar has no route through the gateway, and its first
request goes to a URL the agent chose.

1. `.env`: `BROWSER_TAKEOVER_ORIGIN=https://browser.example.com` (HTTPS, its own hostname; agent-browser refuses an
   HTTP or loopback origin) and, optionally, `BROWSER_TAKEOVER_PORT` (default `3001`). Unset origin = feature off.
2. Route that hostname to `http://localhost:$BROWSER_TAKEOVER_PORT` in the tunnel (cloudflared: an `ingress` entry
   plus `cloudflared tunnel route dns <tunnel> <hostname>`), then restart the host.
