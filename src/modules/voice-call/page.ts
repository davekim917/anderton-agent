const escapeHtml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export function callPageHtml(agentName: string): string {
  const name = escapeHtml(agentName);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Call ${name}</title>
<style>
  :root { --bg: #f6f5f2; --fg: #1d1c1a; --muted: #6d6a64; --accent: #1f7a4d; --danger: #b3261e; --card: #fff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #151513; --fg: #f1efea; --muted: #a29e96; --accent: #45b27c; --danger: #f07167; --card: #1f1e1b; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 28px; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 16px/1.4 -apple-system, system-ui, sans-serif; }
  h1 { margin: 0; font-size: 28px; font-weight: 650; }
  #status { color: var(--muted); min-height: 1.4em; text-align: center; max-width: 32ch; }
  #orb { width: 132px; height: 132px; border-radius: 50%; background: var(--card); box-shadow: 0 0 0 0 var(--accent);
    display: grid; place-items: center; font-size: 44px; transition: box-shadow .25s; }
  #orb.live { box-shadow: 0 0 0 10px color-mix(in srgb, var(--accent) 25%, transparent); }
  .row { display: flex; gap: 16px; }
  button { font: inherit; border: 0; border-radius: 999px; padding: 14px 26px; min-width: 120px; cursor: pointer; }
  #start { background: var(--accent); color: #fff; }
  #mute { background: var(--card); color: var(--fg); }
  #hangup { background: var(--danger); color: #fff; }
  button[hidden] { display: none; }
</style>
</head>
<body>
  <h1>${name}</h1>
  <div id="orb" aria-hidden="true">☎</div>
  <div id="status">Tap Call to start. Use headphones for the best audio.</div>
  <div class="row">
    <button id="start">Call</button>
    <button id="mute" hidden>Mute</button>
    <button id="hangup" hidden>Hang up</button>
  </div>
  <audio id="out" autoplay playsinline></audio>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const status = (text) => { $('status').textContent = text; };
  let pc, mic, wake, events, token = '', ended = false;
  const withToken = (path) => path + '?t=' + encodeURIComponent(token);
  const post = (path, body) => fetch(withToken(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const finish = (text) => {
    if (ended) return;
    ended = true;
    status(text);
    $('orb').classList.remove('live');
    $('mute').hidden = $('hangup').hidden = true;
    try { events && events.close(); } catch {}
    try { pc && pc.close(); } catch {}
    try { mic && mic.getTracks().forEach((t) => t.stop()); } catch {}
    try { wake && wake.release(); } catch {}
  };
  const drop = (text) => { if (token && !ended) post('hangup', { dropped: true }); finish(text); };
  const keepAwake = async () => { try { wake = await navigator.wakeLock.request('screen'); } catch {} };
  document.addEventListener('visibilitychange', () => { if (!ended && document.visibilityState === 'visible') keepAwake(); });
  $('start').onclick = async () => {
    $('start').hidden = true;
    status('Connecting…');
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      pc = new RTCPeerConnection();
      pc.ontrack = (e) => { $('out').srcObject = e.streams[0]; };
      mic.getAudioTracks().forEach((t) => pc.addTrack(t, mic));
      pc.createDataChannel('oai-events');
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') { $('orb').classList.add('live'); post('connected'); }
        if (pc.connectionState === 'failed') drop('The call dropped.');
      };
      await pc.setLocalDescription(await pc.createOffer());
      const res = await post('offer', { sdp: pc.localDescription.sdp });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'The call could not start.');
      token = body.token;
      await pc.setRemoteDescription({ type: 'answer', sdp: body.answer });
      events = new EventSource(withToken('events'));
      events.onerror = () => { if (events.readyState === EventSource.CLOSED) drop('The call was cut off.'); };
      events.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'status') status(msg.text);
        if (msg.type === 'ended') finish(msg.text);
      };
      keepAwake();
      $('mute').hidden = $('hangup').hidden = false;
      status('Live');
    } catch (err) {
      drop(err && err.message ? err.message : 'The call could not start.');
    }
  };
  $('mute').onclick = () => {
    const track = mic && mic.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    $('mute').textContent = track.enabled ? 'Mute' : 'Unmute';
  };
  $('hangup').onclick = () => { post('hangup'); finish('Call ended.'); };
  window.addEventListener('pagehide', () => { if (!ended) navigator.sendBeacon(withToken('hangup'), '{}'); });
})();
</script>
</body>
</html>`;
}
