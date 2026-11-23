// Dictate into a text box with the app's own speech to text. Shared by both versions of the app.
// mount() wires a toggle button. The page passes engine(), which returns { rate, feed(msg), stop() }:
// feed gets each audio worklet message; stop() finishes the last phrase and resolves when it's done.
// Text is inserted where the cursor was when dictation started, and moves along as phrases arrive.
(() => {
  "use strict";
  const FRIENDLY = {
    NotAllowedError: "microphone blocked. Allow it from the address bar icon, then try again",
    NotFoundError: "no microphone found",
    NotReadableError: "microphone is busy in another app",
  };
  function mount({ button, target, status, engine, micId, busy, onChange }) {
    const btn = document.querySelector(button), box = document.querySelector(target), note = document.querySelector(status);
    if (!btn || !box) return { stop: async () => {} };
    let on = false, stopping = false, media = null, ac = null, eng = null, at = 0;
    const say = (t, warn) => { if (note) { note.textContent = t || ""; note.classList.toggle("warn", !!warn) } };
    const show = (state) => {
      btn.classList.toggle("rec", state === "on");
      btn.setAttribute("aria-pressed", String(state === "on"));
      btn.disabled = state === "busy";
      btn.querySelector(".lbl").textContent = state === "on" ? "Stop" : "Dictate";
    };
    const insert = (text) => {
      text = String(text || "").replace(/\s+/g, " ").trim();
      if (!text) return;
      const v = box.value; at = Math.min(at, v.length);
      const before = v.slice(0, at), after = v.slice(at);
      const lead = !before || /\s$/.test(before) ? "" : " ";
      const tail = after && !/^\s/.test(after) ? " " : "";
      box.value = before + lead + text + tail + after;
      at = (before + lead + text).length;
      box.setSelectionRange?.(at, at);
      box.scrollTop = box.scrollHeight * (at / Math.max(1, box.value.length));
      onChange?.();
    };
    const cleanup = () => {
      media?.getTracks().forEach((t) => t.stop()); media = null;
      ac?.close().catch(() => {}); ac = null; eng = null;
    };
    async function start() {
      if (on || stopping) return;
      if (busy?.()) return say("stop listening to the call before dictating", true);
      at = box.selectionEnd ?? box.value.length;
      if (document.activeElement !== box) at = box.value.length;
      show("busy"); say("starting the mic…");
      try {
        eng = await engine({ text: insert, partial: (t) => on && say(t ? "hearing: " + t.slice(-80) : "listening… click Stop when you're done"), status: say });
        const id = micId?.();
        const opts = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
        media = await navigator.mediaDevices.getUserMedia({ audio: { ...opts, deviceId: id ? { exact: id } : undefined } })
          .catch((e) => e.name === "OverconstrainedError" ? navigator.mediaDevices.getUserMedia({ audio: opts }) : Promise.reject(e));
        ac = new AudioContext({ sampleRate: eng.rate });
        if (ac.state === "suspended") await ac.resume().catch(() => {});
        await ac.audioWorklet.addModule("/pcm-worklet.js");
        const node = new AudioWorkletNode(ac, "pcm");
        ac.createMediaStreamSource(media).connect(node);
        node.port.onmessage = ({ data }) => { if (on && eng) eng.feed(data) };
        media.getAudioTracks()[0].onended = () => on && stop();
        on = true; show("on"); say("listening… click Stop when you're done");
      } catch (e) {
        console.warn("dictate", e);
        await eng?.stop().catch(() => {});
        cleanup(); on = false; show("off");
        say("couldn't dictate: " + (FRIENDLY[e.name] || e.message), true);
      }
    }
    async function stop() {
      if (!on || stopping) return;
      on = false; stopping = true; show("busy"); say("finishing the last words…");
      media?.getTracks().forEach((t) => t.stop());
      try { await eng?.stop() } catch (e) { console.warn("dictate stop", e) }
      cleanup(); stopping = false; show("off");
      if (note && !note.classList.contains("warn")) say("");
    }
    btn.addEventListener("click", () => (on ? stop() : start()));
    show("off");
    return { stop, get on() { return on } };
  }
  window.Dictate = { mount };
})();
