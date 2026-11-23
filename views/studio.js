// Studio Console: the live scope, a wave strip per lane under Inputs, and the models as a signal path
// (sound in, speech to text, then the model that coaches). Each model node's LED lights while a call is out;
// select a node to see its calls. No libraries.
// The page calls Studio.level(who, rms) for every audio frame; everything else is read from the page.
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- audio history, fed by the page ----------
  const N = 160; // columns of history per lane, newest on the right
  const hist = { me: new Float32Array(N), them: new Float32Array(N) };
  const lvl = { me: 0, them: 0 }; // smoothed 0..1
  const heard = { me: 0, them: 0 }; // last time each lane was clearly talking
  const amp = (rms) => (rms < 0.004 ? 0 : Math.min(1, Math.sqrt(rms) * 2.4));
  const fed = { me: 0, them: 0 };
  function push(who, a) {
    const h = hist[who];
    h.copyWithin(0, 1); h[N - 1] = Math.max(a, h[N - 2] * 0.82);
    lvl[who] = Math.max(a, lvl[who] * 0.9);
  }
  function level(who, rms) {
    if (!hist[who]) return;
    const a = amp(rms); push(who, a);
    const now = performance.now(); fed[who] = now;
    if (a > 0.3) heard[who] = now;
  }
  const talking = () => {
    const now = performance.now(), m = now - heard.me < 450, t = now - heard.them < 450;
    if (m && t) return lvl.me >= lvl.them ? "me" : "them";
    return m ? "me" : t ? "them" : null;
  };

  // ---------- scope shader (top bar) ----------
  function scope(cv) {
    const gl = cv.getContext("webgl", { antialias: false, premultipliedAlpha: false });
    if (!gl) { cv.classList.add("no-gl"); return () => {} }
    const VS = "attribute vec2 p;varying vec2 uv;void main(){uv=p*.5+.5;gl_Position=vec4(p,0.,1.);}";
    const FS = `precision mediump float;varying vec2 uv;uniform float t;uniform vec2 res;uniform sampler2D H;
float h(float x,float l){return texture2D(H,vec2(clamp(x,0.,1.),l<.5?.25:.75)).r;}
void main(){
  vec3 col=vec3(.055,.057,.06);
  vec2 g=abs(fract(uv*vec2(res.x/34.,4.))-.5);
  col+=vec3(.05,.046,.038)*(step(.47,g.x)+step(.45,g.y));
  for(int i=0;i<2;i++){
    float L=float(i);
    float yc=L<.5?.72:.28;
    float a=h(uv.x,L);
    float w=sin(uv.x*90.-t*9.+sin(uv.x*13.+t*1.3)*2.5)*a*.2+sin(uv.x*29.+t*3.)*a*.05;
    float d=abs(uv.y-yc-w)*res.y;
    vec3 c=L<.5?vec3(1.,.71,.28):vec3(.37,.94,.82);
    col+=c*(1.1/(d+1.4))+c*.22*exp(-d*.06)*a;
  }
  col*=.93+.07*sin(gl_FragCoord.y*2.1);
  gl_FragColor=vec4(col,1.);
}`;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn(gl.getShaderInfoLog(s)); return s };
    const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr); gl.useProgram(pr);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture()); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    const uT = gl.getUniformLocation(pr, "t"), uR = gl.getUniformLocation(pr, "res"), tex = new Uint8Array(N * 2);
    return (t) => {
      const dpr = Math.min(2, devicePixelRatio || 1), w = Math.round(cv.clientWidth * dpr), hgt = Math.round(cv.clientHeight * dpr);
      if (!w || !hgt) return;
      if (cv.width !== w || cv.height !== hgt) { cv.width = w; cv.height = hgt }
      for (let i = 0; i < N; i++) { tex[i] = hist.me[i] * 255; tex[N + i] = hist.them[i] * 255 }
      gl.viewport(0, 0, w, hgt);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, N, 2, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, tex);
      gl.uniform1f(uT, reduce ? 0 : t); gl.uniform2f(uR, w, hgt);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
  }

  // ---------- inputs: one live wave strip per lane ----------
  const BARS = 32;
  const strip = (who, label, chip) => `<div class="wv-row" data-lane="${who}"><span class="wv-dot ${who}" title="${label}"></span><span class="wave ${who}" aria-hidden="true">${"<i></i>".repeat(BARS)}</span>${chip}</div>`;

  // ---------- models: signal path, sound in, text, then advice ----------
  // One node per distinct model, with the jobs it does. Its LED lights while any of its calls is out.
  const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  function pathHTML(A) {
    const groups = [];
    for (const m of A.models.values()) {
      const name = m.model || "not loaded";
      let g = groups.find((x) => x.name === name && x.where === m.where);
      if (!g) groups.push((g = { name, where: m.where || "", size: m.size || "", roles: [] }));
      g.roles.push(m); if (m.size) g.size = m.size;
    }
    const node = (g) => `<button type="button" class="pn" data-role="${esc(g.roles[0].role)}" aria-label="${esc(g.roles.map((r) => r.title || r.role).join(", "))}: ${esc(g.name)}. Show its calls.">
        <span class="pn-cap"><span>${esc(g.roles.map((r) => r.title || r.role).join(" · "))}</span><span class="led" data-roles="${esc(g.roles.map((r) => r.role).join(" "))}"></span></span>
        <span class="pn-name">${esc(A.short(g.name))}</span>
        <span class="pn-sub">${esc([g.where, g.size].filter(Boolean).join(" · "))}</span></button>`;
    return `<div class="pn src">Your mic and the meeting tab</div>${groups.map((g) => `<span class="pa" aria-hidden="true">↓</span>${node(g)}`).join("")}`;
  }

  // ---------- mount ----------
  function mount() {
    const inBox = $("#inputs"), cv = $("#scope"), A = window.Activity;
    if (inBox) inBox.innerHTML = `<figure class="fig inp">
      ${strip("me", "You", `<span class="chip-slot"></span>`)}
      ${strip("them", "Them", `<span class="chip" id="in-tab-lbl">Meeting tab</span>`)}
      <div class="cap"><span>Recent level · you and them</span><span class="hi" id="in-readout">idle</span></div></figure>`;
    const mic = $("#mic"); if (mic && inBox) { mic.classList.add("chip"); inBox.querySelector(".chip-slot").replaceWith(mic) }
    const rackBox = $("#rack");
    const flash = new Map(); // role -> { state, until }
    const paintLeds = () => {
      if (!A || !rackBox) return;
      const now = performance.now();
      rackBox.querySelectorAll(".led[data-roles]").forEach((led) => {
        const roles = led.dataset.roles.split(" ");
        const out = roles.some((r) => A.pending(r));
        const f = roles.map((r) => flash.get(r)).find((x) => x && x.until > now);
        led.className = "led " + (out ? "out" : f ? f.state : "");
      });
      const n = A.pending(), ro = $("#rack-readout");
      if (ro) ro.textContent = n ? `${n} call${n === 1 ? "" : "s"} out` : "idle";
    };
    const drawPath = () => {
      if (!rackBox || !A) return;
      rackBox.innerHTML = `<figure class="fig path">${pathHTML(A)}
        <div class="cap"><span>Select a model · see its calls</span><span class="hi" id="rack-readout">idle</span></div></figure>`;
      paintLeds();
    };
    if (A) {
      A.on((ev) => {
        if (ev.type === "models") return drawPath();
        const e = ev.e; if (e.state !== "out") flash.set(e.role, { state: e.state, until: performance.now() + (e.state === "err" ? 4000 : 1200) });
        paintLeds();
      });
      drawPath();
      rackBox?.addEventListener("click", (e) => { const u = e.target.closest(".pn[data-role]"); if (u) A.openLog(u.dataset.role) });
      setInterval(paintLeds, 250);
    }
    const draw = cv ? scope(cv) : () => {};

    // state read from the page
    const st = { live: false };
    const status = $("#status");
    const readPage = () => {
      st.live = !!status?.classList.contains("live");
      document.body.classList.toggle("on-air", st.live);
    };
    if (status) new MutationObserver(readPage).observe(status, { attributes: true, childList: true, characterData: true, subtree: true });
    readPage();

    const iro = $("#in-readout"), tabLbl = $("#in-tab-lbl");
    const bars = { me: [...document.querySelectorAll('#inputs .wave.me i')], them: [...document.querySelectorAll('#inputs .wave.them i')] };
    let lastRead = "";
    const t0 = performance.now();
    function tick(now) {
      requestAnimationFrame(tick);
      draw((now - t0) / 1000);
      // wave strips: the last BARS*4 frames of each lane, one bar per 4
      for (const w of ["me", "them"]) {
        const h = hist[w], b = bars[w];
        for (let i = 0; i < b.length; i++) {
          let a = 0; for (let k = 0; k < 4; k++) a = Math.max(a, h[N - (b.length - i) * 4 + k] || 0);
          b[i].style.height = Math.max(2, Math.round(a * 22)) + "px";
        }
      }
      const notShared = st.live && !lanes.them;
      if (tabLbl) { tabLbl.textContent = notShared ? "Tab not shared" : "Meeting tab"; tabLbl.classList.toggle("warn", notShared) }
      const who = st.live ? talking() : null;
      const read = !st.live ? "idle" : who === "me" ? "you're talking" : who === "them" ? "they're talking" : "listening";
      if (read !== lastRead && iro) { iro.textContent = read; lastRead = read }
      // no audio arriving (stopped, or a lane not shared): let the strips and scope fall flat
      for (const w of ["me", "them"]) if (now - fed[w] > 60) { push(w, 0) }
    }
    requestAnimationFrame(tick);
  }

  const lanes = { me: false, them: false };
  window.Studio = { level, lanes: (x) => Object.assign(lanes, x) };
  document.readyState === "loading" ? addEventListener("DOMContentLoaded", mount) : mount();
})();
