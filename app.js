(() => {
  "use strict";

  const MAX_BLOBS = 6;
  const MIN_BLOBS = 2;

  const PRESETS = [
    { name: "Dusk pool", bg: "#1b1840", colors: ["#ff7a59", "#ffc15e", "#7a5cff", "#2ec4b6"] },
    { name: "Peach fuzz", bg: "#ffe3d3", colors: ["#ff9f80", "#ff6f91", "#ffd5a5", "#c49bff"] },
    { name: "Lagoon", bg: "#04363f", colors: ["#1fd1b5", "#7cf3d6", "#2f80ed", "#c8f560"] },
    { name: "Pistachio", bg: "#eef3e2", colors: ["#b8e07a", "#6fcf97", "#f7d36b", "#f59ab5"] },
    { name: "Night market", bg: "#101a2e", colors: ["#ff4d8d", "#3ddcff", "#ffe45e"] },
    { name: "Plum jam", bg: "#2a0f2e", colors: ["#c2185b", "#ff8a65", "#8e44ad", "#f8bbd0", "#5e35b1"] },
  ];

  const DEFAULTS = {
    bg: PRESETS[0].bg,
    colors: PRESETS[0].colors.slice(),
    size: 0.45,
    edge: 0.15,
    warp: 0.45,
    move: 0.6,
    speed: 0.35,
    grain: 0.35,
    seed: 7,
  };

  const SLIDER_KEYS = ["size", "edge", "warp", "move", "speed", "grain"];

  // ---------- Helpers ----------

  const $ = (sel) => document.querySelector(sel);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const TAU = Math.PI * 2;

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function isHex(s) { return /^#?[0-9a-f]{6}$/i.test(s); }
  function normHex(s) { s = s.trim().toLowerCase(); return s[0] === "#" ? s : "#" + s; }

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbToHex([r, g, b]) {
    return "#" + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");
  }

  function luminance([r, g, b]) {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }

  function saturation([r, g, b]) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return mx === 0 ? 0 : (mx - mn) / mx;
  }

  function loopSeconds(speed) { return Math.round(lerp(40, 5, speed)); }

  let toastTimer;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("is-on"), 2600);
  }

  // ---------- State + URL ----------

  const state = structuredClone(DEFAULTS);

  function readHash() {
    const h = location.hash.replace(/^#/, "");
    if (!h) return;
    const p = new URLSearchParams(h);
    const cols = (p.get("c") || "").split(",").filter(isHex).map(normHex);
    if (cols.length >= MIN_BLOBS) state.colors = cols.slice(0, MAX_BLOBS);
    if (isHex(p.get("bg") || "")) state.bg = normHex(p.get("bg"));
    for (const k of SLIDER_KEYS) {
      const v = parseFloat(p.get(k));
      if (!Number.isNaN(v)) state[k] = clamp(v, 0, 1);
    }
    const s = parseInt(p.get("seed"), 10);
    if (!Number.isNaN(s)) state.seed = s;
  }

  function hashString() {
    const p = new URLSearchParams();
    p.set("c", state.colors.map((c) => c.slice(1)).join(","));
    p.set("bg", state.bg.slice(1));
    for (const k of SLIDER_KEYS) p.set(k, state[k].toFixed(2));
    p.set("seed", String(state.seed));
    return p.toString();
  }

  let hashTimer;
  function syncHash() {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(() => history.replaceState(null, "", "#" + hashString()), 250);
  }

  readHash();

  // ---------- WebGL ----------

  const canvas = $("#stage");
  const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true, antialias: false, alpha: false });

  if (!gl) {
    document.body.innerHTML = '<p class="noscript">Blobby needs WebGL, which this browser has turned off. Try another browser or turn on hardware acceleration.</p>';
    return;
  }

  const VERT = `
    attribute vec2 aPos;
    void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
  `;

  const FRAG = `
    precision highp float;
    uniform vec2 uRes;
    uniform float uPhase;
    uniform vec3 uBg;
    uniform vec3 uCol[${MAX_BLOBS}];
    uniform vec3 uBlob[${MAX_BLOBS}];
    uniform float uCount;
    uniform float uEdge;
    uniform float uWarp;
    uniform float uGrain;
    uniform float uGrainSeed;

    vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }

    float snoise(vec2 v) {
      const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
      vec2 i = floor(v + dot(v, C.yy));
      vec2 x0 = v - i + dot(i, C.xx);
      vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
      vec4 x12 = x0.xyxy + C.xxzz;
      x12.xy -= i1;
      i = mod(i, 289.0);
      vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
      vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
      m = m * m; m = m * m;
      vec3 x = 2.0 * fract(p * C.www) - 1.0;
      vec3 h = abs(x) - 0.5;
      vec3 ox = floor(x + 0.5);
      vec3 a0 = x - ox;
      m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
      vec3 g;
      g.x = a0.x * x0.x + h.x * x0.y;
      g.yz = a0.yz * x12.xz + h.yz * x12.yw;
      return 130.0 * dot(m, g);
    }

    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / uRes;
      float aspect = uRes.x / uRes.y;
      vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);

      // Noise sampled on a circle, so the wobble loops with the phase.
      float th = uPhase * 6.2831853;
      vec2 o = vec2(cos(th), sin(th)) * 0.55;
      vec2 w = vec2(snoise(p * 1.25 + o), snoise(p * 1.25 - o + 7.31));
      p += w * uWarp;

      vec3 acc = uBg * 0.4;
      float wsum = 0.4;
      for (int i = 0; i < ${MAX_BLOBS}; i++) {
        if (float(i) >= uCount) break;
        vec2 d = p - uBlob[i].xy;
        float r = uBlob[i].z;
        float k = dot(d, d) / (r * r);
        float wi = 5.0 * exp(-pow(k, uEdge));
        acc += uCol[i] * wi;
        wsum += wi;
      }
      vec3 col = acc / wsum;

      float g = hash(gl_FragCoord.xy + uGrainSeed) - 0.5;
      col += g * uGrain;

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const U = {};
  for (const n of ["uRes", "uPhase", "uBg", "uCol", "uBlob", "uCount", "uEdge", "uWarp", "uGrain", "uGrainSeed"]) {
    U[n] = gl.getUniformLocation(prog, n);
  }

  // Per-blob paths. Integer frequencies keep every path periodic over one loop.
  let paths = [];
  function buildPaths() {
    const rnd = mulberry32(state.seed * 9973 + 11);
    paths = [];
    for (let i = 0; i < MAX_BLOBS; i++) {
      // Spread starting points around an ellipse so blobs don't pile up.
      const a = (i / MAX_BLOBS) * TAU + rnd() * 0.9;
      const rad = 0.35 + rnd() * 0.55;
      paths.push({
        fx: Math.cos(a) * rad,
        fy: Math.sin(a) * rad,
        ax: 0.12 + rnd() * 0.22,
        ay: 0.1 + rnd() * 0.18,
        kx: rnd() < 0.35 ? 2 : 1,
        ky: rnd() < 0.35 ? 2 : 1,
        dir: rnd() < 0.5 ? -1 : 1,
        px: rnd() * TAU,
        py: rnd() * TAU,
        rs: 0.75 + rnd() * 0.5,
      });
    }
  }
  buildPaths();

  const colBuf = new Float32Array(MAX_BLOBS * 3);
  const blobBuf = new Float32Array(MAX_BLOBS * 3);

  let phase = 0;
  let grainSeed = 0;

  function draw() {
    const w = canvas.width, h = canvas.height;
    const aspect = w / h;
    gl.viewport(0, 0, w, h);

    const n = state.colors.length;
    const baseR = 0.16 + state.size * 0.42;
    const move = state.move;
    const spreadX = aspect * 0.5 * 0.78;
    const spreadY = 0.5 * 0.8;
    const ampScale = Math.sqrt(Math.max(aspect, 1 / aspect));

    for (let i = 0; i < MAX_BLOBS; i++) {
      const pth = paths[i];
      const x = pth.fx * spreadX + pth.ax * move * ampScale * Math.sin(TAU * pth.kx * pth.dir * phase + pth.px);
      const y = pth.fy * spreadY + pth.ay * move * Math.cos(TAU * pth.ky * phase + pth.py);
      blobBuf[i * 3] = x;
      blobBuf[i * 3 + 1] = y;
      blobBuf[i * 3 + 2] = baseR * pth.rs;

      const c = hexToRgb(state.colors[i] || state.bg);
      colBuf[i * 3] = c[0] / 255;
      colBuf[i * 3 + 1] = c[1] / 255;
      colBuf[i * 3 + 2] = c[2] / 255;
    }

    const bg = hexToRgb(state.bg);
    gl.uniform2f(U.uRes, w, h);
    gl.uniform1f(U.uPhase, phase);
    gl.uniform3f(U.uBg, bg[0] / 255, bg[1] / 255, bg[2] / 255);
    gl.uniform3fv(U.uCol, colBuf);
    gl.uniform3fv(U.uBlob, blobBuf);
    gl.uniform1f(U.uCount, n);
    gl.uniform1f(U.uEdge, lerp(1, 4.5, state.edge));
    gl.uniform1f(U.uWarp, state.warp * 0.32);
    gl.uniform1f(U.uGrain, state.grain * 0.16);
    gl.uniform1f(U.uGrainSeed, grainSeed);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // ---------- Sizing ----------

  let fixedSize = null; // {w,h} while exporting or recording

  function fitToWindow() {
    if (fixedSize) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(window.innerWidth * dpr);
    const h = Math.round(window.innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }
  window.addEventListener("resize", fitToWindow);
  fitToWindow();

  function targetSize(forVideo) {
    const v = $("#sizeSelect").value;
    let w, h;
    if (v === "window") {
      const dpr = forVideo ? 1 : Math.min(window.devicePixelRatio || 1, 2);
      w = Math.round(window.innerWidth * dpr);
      h = Math.round(window.innerHeight * dpr);
    } else {
      [w, h] = v.split("x").map(Number);
    }
    if (forVideo) {
      const s = Math.min(1, 1920 / Math.max(w, h));
      w = Math.round((w * s) / 2) * 2;
      h = Math.round((h * s) / 2) * 2;
    }
    return { w, h };
  }

  // ---------- Animation loop ----------

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let playing = !reduceMotion;
  let last = performance.now();

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (playing) {
      phase = (phase + dt / loopSeconds(state.speed)) % 1;
      grainSeed = (grainSeed + 37.13) % 1000;
    }
    if (recording) {
      recording.elapsed += dt;
      const left = Math.max(0, Math.ceil(recording.total - recording.elapsed));
      $("#recText").textContent = `Recording loop, ${left}s left`;
    }
    draw();
    requestAnimationFrame(frame);
  }

  // ---------- UI: presets ----------

  function chipGradient(p) {
    const spots = [["20% 30%"], ["80% 20%"], ["70% 85%"], ["25% 80%"], ["50% 50%"], ["90% 60%"]];
    const layers = p.colors.map((c, i) => `radial-gradient(circle at ${spots[i % spots.length]}, ${c} 0, transparent 60%)`);
    return layers.join(", ") + `, ${p.bg}`;
  }

  function samePalette(p) {
    return p.bg === state.bg && p.colors.length === state.colors.length && p.colors.every((c, i) => c === state.colors[i]);
  }

  function renderPresets() {
    const wrap = $("#presets");
    wrap.innerHTML = "";
    PRESETS.forEach((p) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "preset";
      b.setAttribute("aria-pressed", String(samePalette(p)));
      b.innerHTML = `<span class="preset-chip" style="background:${chipGradient(p)}"></span><span class="preset-name">${p.name}</span>`;
      b.addEventListener("click", () => {
        state.bg = p.bg;
        state.colors = p.colors.slice();
        refresh();
      });
      wrap.appendChild(b);
    });
  }

  // ---------- UI: swatches ----------

  function renderSwatches() {
    const wrap = $("#swatches");
    wrap.innerHTML = "";
    state.colors.forEach((c, i) => {
      const lab = document.createElement("label");
      lab.className = "swatch";
      lab.style.background = c;

      const inp = document.createElement("input");
      inp.type = "color";
      inp.value = c;
      inp.setAttribute("aria-label", `Blob colour ${i + 1}`);
      inp.addEventListener("input", () => {
        state.colors[i] = inp.value;
        lab.style.background = inp.value;
        updateAccent();
        renderPresets();
        syncHash();
      });
      lab.appendChild(inp);

      if (state.colors.length > MIN_BLOBS) {
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "swatch-remove";
        rm.textContent = "×";
        rm.setAttribute("aria-label", `Remove colour ${i + 1}`);
        rm.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          state.colors.splice(i, 1);
          refresh();
        });
        lab.appendChild(rm);
      }
      wrap.appendChild(lab);
    });

    if (state.colors.length < MAX_BLOBS) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "swatch-add";
      add.textContent = "+";
      add.setAttribute("aria-label", "Add a colour");
      add.addEventListener("click", () => {
        // New colour: a shifted mix of the last colour, so it sits in the palette.
        const base = hexToRgb(state.colors[state.colors.length - 1]);
        const other = hexToRgb(state.colors[0]);
        const mixed = base.map((v, k) => (v + other[k]) / 2 + (k === 2 ? 40 : -20));
        state.colors.push(rgbToHex(mixed));
        refresh();
      });
      wrap.appendChild(add);
    }

    $("#bgInput").value = state.bg;
    $("#bgSwatch").style.background = state.bg;
  }

  $("#bgInput").addEventListener("input", (e) => {
    state.bg = e.target.value;
    $("#bgSwatch").style.background = state.bg;
    document.querySelector('meta[name="theme-color"]').content = state.bg;
    renderPresets();
    syncHash();
  });

  function updateAccent() {
    // Sliders pick up the most saturated blob colour, so the panel follows the palette.
    const best = state.colors.slice().sort((a, b) => saturation(hexToRgb(b)) - saturation(hexToRgb(a)))[0];
    document.documentElement.style.setProperty("--accent", best);
  }

  // ---------- UI: sliders ----------

  function setFill(input) {
    input.style.setProperty("--fill", `${input.value * 100}%`);
  }

  function updateLoopLabel() {
    const s = loopSeconds(state.speed);
    $("#loopLen").textContent = `${s}s loop`;
    $("#recBtn").textContent = "Record loop";
    $("#recBtn").setAttribute("aria-label", `Record a ${s} second loop`);
  }

  document.querySelectorAll('input[type="range"][data-key]').forEach((input) => {
    input.addEventListener("input", () => {
      state[input.dataset.key] = parseFloat(input.value);
      setFill(input);
      if (input.dataset.key === "speed") updateLoopLabel();
      syncHash();
    });
  });

  function syncSliders() {
    document.querySelectorAll('input[type="range"][data-key]').forEach((input) => {
      input.value = state[input.dataset.key];
      setFill(input);
    });
    updateLoopLabel();
  }

  function refresh() {
    renderPresets();
    renderSwatches();
    syncSliders();
    updateAccent();
    document.querySelector('meta[name="theme-color"]').content = state.bg;
    syncHash();
  }

  // ---------- Motion controls ----------

  function setPlaying(v) {
    playing = v;
    const b = $("#playBtn");
    b.textContent = playing ? "Pause" : "Play";
    b.setAttribute("aria-pressed", String(!playing));
  }

  function shuffle() {
    state.seed = Math.floor(Math.random() * 100000);
    buildPaths();
    syncHash();
  }

  function setPanel(open) {
    $("#panel").classList.toggle("is-hidden", !open);
    const b = $("#panelBtn");
    b.textContent = open ? "Hide controls" : "Show controls";
    b.setAttribute("aria-expanded", String(open));
    quietDock(!open);
  }

  // When the panel is hidden, the dock fades out after a few idle seconds.
  let idleTimer;
  let dockQuietAllowed = false;
  function quietDock(allowed) {
    dockQuietAllowed = allowed;
    wake();
  }
  function wake() {
    $(".dock").classList.remove("is-quiet");
    clearTimeout(idleTimer);
    if (dockQuietAllowed) idleTimer = setTimeout(() => $(".dock").classList.add("is-quiet"), 2500);
  }
  window.addEventListener("pointermove", wake);

  $("#playBtn").addEventListener("click", () => setPlaying(!playing));
  $("#panelBtn").addEventListener("click", () => setPanel($("#panel").classList.contains("is-hidden")));
  $("#shuffleBtn").addEventListener("click", shuffle);

  window.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if ($("#intro")?.open) return;
    if (e.code === "Space" && !(t && t.tagName === "BUTTON")) { e.preventDefault(); setPlaying(!playing); }
    else if (e.key === "h" || e.key === "H") setPanel($("#panel").classList.contains("is-hidden"));
    else if (e.key === "r" || e.key === "R") shuffle();
    wake();
  });

  // ---------- Palette from a photo ----------

  function extractPalette(img) {
    const S = 96;
    const scale = Math.min(1, S / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;

    const px = [];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      px.push([data[i], data[i + 1], data[i + 2]]);
    }
    if (px.length < 8) return null;

    const K = 6;
    const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

    // Farthest-point start, then k-means.
    const cents = [px[Math.floor(px.length / 2)].slice()];
    while (cents.length < K) {
      let best = null, bestD = -1;
      for (let i = 0; i < px.length; i += 3) {
        let m = Infinity;
        for (const ce of cents) m = Math.min(m, d2(px[i], ce));
        if (m > bestD) { bestD = m; best = px[i]; }
      }
      cents.push(best.slice());
    }

    let counts = new Array(K).fill(0);
    for (let iter = 0; iter < 10; iter++) {
      const sums = cents.map(() => [0, 0, 0]);
      counts = new Array(K).fill(0);
      for (const p of px) {
        let bi = 0, bd = Infinity;
        for (let k = 0; k < K; k++) { const d = d2(p, cents[k]); if (d < bd) { bd = d; bi = k; } }
        sums[bi][0] += p[0]; sums[bi][1] += p[1]; sums[bi][2] += p[2];
        counts[bi]++;
      }
      for (let k = 0; k < K; k++) if (counts[k]) cents[k] = sums[k].map((v) => v / counts[k]);
    }

    const clusters = cents.map((c, k) => ({ c, n: counts[k] })).filter((x) => x.n > px.length * 0.01);
    clusters.sort((a, b) => b.n - a.n);

    // The most common colour becomes the background; the rest become blobs, most vivid first.
    const bg = clusters[0].c;
    let rest = clusters.slice(1).filter((x) => d2(x.c, bg) > 400);
    rest.sort((a, b) => saturation(b.c) - saturation(a.c));
    let colors = rest.slice(0, 4).map((x) => rgbToHex(x.c));

    // Flat images give too few colours: pad with lighter and darker takes on the background.
    const lum = luminance(bg);
    while (colors.length < MIN_BLOBS) {
      const shift = (colors.length + 1) * (lum > 0.5 ? -45 : 55);
      colors.push(rgbToHex(bg.map((v) => v + shift)));
    }
    return { bg: rgbToHex(bg), colors };
  }

  function usePhoto(file) {
    if (!file || !file.type.startsWith("image/")) {
      toast("That file isn't an image. Try a JPG, PNG or WebP.");
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const pal = extractPalette(img);
      URL.revokeObjectURL(url);
      if (!pal) { toast("Couldn't find enough colour in that image. Try another one."); return; }
      state.bg = pal.bg;
      state.colors = pal.colors;
      refresh();
      toast(`Colours pulled from ${file.name}.`);
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast("Couldn't open that image. Try a JPG, PNG or WebP."); };
    img.src = url;
  }

  $("#photoInput").addEventListener("change", (e) => {
    usePhoto(e.target.files[0]);
    e.target.value = "";
  });

  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
    dragDepth++;
    $("#drop").hidden = false;
  });
  window.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $("#drop").hidden = true;
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    $("#drop").hidden = true;
    const f = e.dataTransfer?.files?.[0];
    if (f) usePhoto(f);
  });

  // ---------- Export ----------

  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function setSize(w, h) {
    fixedSize = { w, h };
    canvas.width = w;
    canvas.height = h;
  }

  function releaseSize() {
    fixedSize = null;
    fitToWindow();
  }

  $("#pngBtn").addEventListener("click", () => {
    const { w, h } = targetSize(false);
    setSize(w, h);
    draw();
    canvas.toBlob((blob) => {
      releaseSize();
      if (!blob) { toast("Couldn't save the image. Try a smaller size."); return; }
      download(blob, `blobby-${w}x${h}.png`);
      toast(`Image saved (${w} × ${h}).`);
    }, "image/png");
  });

  let recording = null;

  function pickMime() {
    const options = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    return options.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
  }

  function stopRecording(save) {
    if (!recording) return;
    recording.save = save;
    clearTimeout(recording.timer);
    if (recording.rec.state !== "inactive") recording.rec.stop();
  }

  $("#recBtn").addEventListener("click", () => {
    if (recording) return;
    if (!window.MediaRecorder || !canvas.captureStream) {
      toast("This browser can't record video. Save an image instead, or try Chrome, Edge or Safari.");
      return;
    }
    const mime = pickMime();
    const { w, h } = targetSize(true);
    setSize(w, h);

    const stream = canvas.captureStream(30);
    let rec;
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 12_000_000 } : undefined);
    } catch (err) {
      releaseSize();
      toast("This browser can't record video here. Save an image instead.");
      return;
    }

    const chunks = [];
    const total = loopSeconds(state.speed);
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const r = recording;
      recording = null;
      stream.getTracks().forEach((t) => t.stop());
      releaseSize();
      setPlaying(r.wasPlaying);
      $("#recBar").hidden = true;
      $("#recBtn").disabled = false;
      $("#pngBtn").disabled = false;
      if (r.save && chunks.length) {
        const type = rec.mimeType || mime || "video/webm";
        const ext = type.includes("mp4") ? "mp4" : "webm";
        download(new Blob(chunks, { type }), `blobby-loop-${w}x${h}.${ext}`);
        toast(ext === "webm" ? "Loop saved as WebM. Most editors and Figma accept it; convert to MP4 if you need to." : "Loop saved.");
      } else if (r.save) {
        toast("Recording came out empty. Try again with the tab in front.");
      } else {
        toast("Recording cancelled.");
      }
    };

    recording = { rec, total, elapsed: 0, save: true, wasPlaying: playing, timer: 0 };
    phase = 0;
    setPlaying(true);
    $("#recBar").hidden = false;
    $("#recBtn").disabled = true;
    $("#pngBtn").disabled = true;
    rec.start(250);
    recording.timer = setTimeout(() => stopRecording(true), total * 1000 + 120);
  });

  $("#recCancel").addEventListener("click", () => stopRecording(false));

  async function copy(text, done) {
    try {
      await navigator.clipboard.writeText(text);
      toast(done);
    } catch {
      window.prompt("Copy this:", text);
    }
  }

  $("#linkBtn").addEventListener("click", () => {
    const url = location.origin + location.pathname + "#" + hashString();
    copy(url, "Link copied. It opens this exact background.");
  });

  $("#hexBtn").addEventListener("click", () => {
    copy([state.bg, ...state.colors].join(", "), "Hex codes copied, background first.");
  });

  // ---------- Intro pop-up: at most once a day per visitor ----------

  function showIntroIfDue() {
    const dlg = $("#intro");
    if (!dlg || typeof dlg.showModal !== "function") return false;
    const d = new Date();
    const today = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    let last = null;
    try { last = localStorage.getItem("blobby-intro-seen"); } catch {}
    if (last === today) return false;
    try { localStorage.setItem("blobby-intro-seen", today); } catch {}
    dlg.showModal();
    // Clicking the dimmed area outside the card closes it too.
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
    return true;
  }

  // ---------- Go ----------

  const introShown = showIntroIfDue();
  refresh();
  setPlaying(playing);
  if (reduceMotion && !introShown) toast("Motion is paused because your device asks for reduced motion. Press Play to preview it.");
  requestAnimationFrame((t) => { last = t; frame(t); });
})();
