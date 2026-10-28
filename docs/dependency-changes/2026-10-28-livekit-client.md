# livekit-client 2.23.0 for group calls

Group calls run a LiveKit room on the host. The people on a call, and the bridge that puts the agent's voice in the
room, need LiveKit's browser client. The host never imports this package: it reads the self-contained browser bundle
`dist/livekit-client.umd.js` as text and serves it to the call page (`/lk.js`) and into the bridge's Chromium
(`src/modules/voice-call/group/bridge-page.ts`). The bundle has no `require` or `import` of its own, so the packages it
depends on are installed but never executed on the host; what runs is the bundle, in a browser.

2.23.0 is the latest stable release. The room spike ran 2.22.4; a live end-to-end call with three simulated phones
ran on 2.23.0 before this change (see the PR).

## livekit-client none → 2.23.0

Source: https://github.com/livekit/client-sdk-js/blob/v2.23.0/CHANGELOG.md (the 2.23.0 and 2.22.4 sections, read against the 2.22.4 the room spike ran; the lines below are the behaviours group calls rely on)

- a phone joins the room through the host's signaling gate, everyone hears each other and the agent's voice, and the bridge receives each person's track separately · not covered: a live end-to-end run (three simulated phones, real room, real voice service), not a suite test; the gate's half is `src/modules/voice-call/group/signal-gate.test.ts`
- signaling uses `/rtc/v1` first and its `/rtc/v1/validate` pre-check, falling back to `/rtc` and `/rtc/validate`; the gate forwards exactly these four paths and refuses every other one · test: src/modules/voice-call/group/signal-gate.test.ts
- a resume packs its reconnect flag inside the protobuf `join_request` rather than a query parameter, so the gate re-checks standing on every upgrade instead of reading the flag · test: src/modules/voice-call/group/signal-gate.test.ts
- a participant removed by the server disconnects with `DisconnectReason.PARTICIPANT_REMOVED`, which the call page shows as "You were removed from the call." · not covered: observed in the live end-to-end run
- the client refreshes its own token over signaling, so a kept token is only ever presented at an upgrade the gate checks · test: src/modules/voice-call/group/signal-gate.test.ts
- 2.23.0: reconnect retries are jittered (the first waits 0 to 500 ms), and a full reconnect in flight is cancelled when the room disconnects; every retry is still an upgrade through the gate · test: src/modules/voice-call/group/signal-gate.test.ts
- 2.23.0: the SDK releases the audio contexts it creates when a room disconnects, and the connection-error validation timeout is shorter; the bridge builds its own audio graph and never hands one to the SDK · not covered: observed in the live end-to-end run
- 2.23.0 camera bitrate hints, backup codecs, E2EE and RPC fixes · not covered: group calls publish microphone audio only (`canPublishSources: ['microphone']`), with no E2EE, RPC or data

## @bufbuild/protobuf none → 1.10.1

Source: livekit-client 2.23.0's dependency tree (pnpm-lock.yaml)

- bundled into livekit-client's browser bundle and installed alongside it; the host never loads it, so it runs only inside that bundle in a browser · not covered: no host code imports it (grep), and the bundle the host serves has no require or import

## @livekit/mutex none → 1.1.1

Source: livekit-client 2.23.0's dependency tree (pnpm-lock.yaml)

- bundled into livekit-client's browser bundle and installed alongside it; the host never loads it, so it runs only inside that bundle in a browser · not covered: no host code imports it (grep), and the bundle the host serves has no require or import

## @livekit/protocol none → 1.52.1

Source: livekit-client 2.23.0's dependency tree (pnpm-lock.yaml)

- bundled into livekit-client's browser bundle and installed alongside it; the host never loads it, so it runs only inside that bundle in a browser · not covered: no host code imports it (grep), and the bundle the host serves has no require or import

## loglevel none → 1.9.2

Source: livekit-client 2.23.0's dependency tree (pnpm-lock.yaml)

- bundled into livekit-client's browser bundle and installed alongside it; the host never loads it, so it runs only inside that bundle in a browser · not covered: no host code imports it (grep), and the bundle the host serves has no require or import

## machina none → 7.0.1

Source: livekit-client 2.23.0's dependency tree (pnpm-lock.yaml)

- bundled into livekit-client's browser bundle and installed alongside it; the host never loads it, so it runs only inside that bundle in a browser · not covered: no host code imports it (grep), and the bundle the host serves has no require or import

## rxjs none → 7.8.2

Source: livekit-client 2.23.0's dependency tree (pnpm-lock.yaml)

- bundled into livekit-client's browser bundle and installed alongside it; the host never loads it, so it runs only inside that bundle in a browser · not covered: no host code imports it (grep), and the bundle the host serves has no require or import

## sdp none → 3.2.2

Source: livekit-client 2.23.0's dependency tree (pnpm-lock.yaml)

- bundled into livekit-client's browser bundle and installed alongside it; the host never loads it, so it runs only inside that bundle in a browser · not covered: no host code imports it (grep), and the bundle the host serves has no require or import

## sdp-transform none → 2.15.0

Source: livekit-client 2.23.0's dependency tree (pnpm-lock.yaml)

- bundled into livekit-client's browser bundle and installed alongside it; the host never loads it, so it runs only inside that bundle in a browser · not covered: no host code imports it (grep), and the bundle the host serves has no require or import

## typed-emitter none → 2.1.0

Source: livekit-client 2.23.0's dependency tree (pnpm-lock.yaml)

- bundled into livekit-client's browser bundle and installed alongside it; the host never loads it, so it runs only inside that bundle in a browser · not covered: no host code imports it (grep), and the bundle the host serves has no require or import

## webrtc-adapter none → 9.0.6

Source: livekit-client 2.23.0's dependency tree (pnpm-lock.yaml)

- bundled into livekit-client's browser bundle and installed alongside it; the host never loads it, so it runs only inside that bundle in a browser · not covered: no host code imports it (grep), and the bundle the host serves has no require or import
