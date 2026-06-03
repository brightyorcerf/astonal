import { useState, useEffect, useRef, useCallback } from "react";
import * as THREE from "three";

/* ═══════════════════════════════════════════════════════════════
   TYPES
═══════════════════════════════════════════════════════════════ */

// All worker message contracts — strict discriminated unions, zero any

/* ═══════════════════════════════════════════════════════════════
   SSRF GUARD  (client-side mirror of backend proxy validation)
═══════════════════════════════════════════════════════════════ */
function ssrfGuard(raw) {
  let u;
  try { u = new URL(raw); } catch { return "Malformed URL — cannot parse"; }
  if (!/^https?:$/.test(u.protocol)) return "Only HTTP / HTTPS allowed";
  const h = u.hostname.toLowerCase();
  const deny = ["localhost","127.0.0.1","0.0.0.0","::1","169.254.169.254","::ffff:169.254.169.254"];
  if (deny.includes(h)) return `SSRF blocked: ${h}`;
  const m = h.match(/^(\d+)\.(\d+)/);
  if (m) {
    const [a, b] = [+m[1], +m[2]];
    if (a === 10) return "RFC 1918 blocked: 10.x.x.x";
    if (a === 172 && b >= 16 && b <= 31) return "RFC 1918 blocked: 172.16–31.x.x";
    if (a === 192 && b === 168) return "RFC 1918 blocked: 192.168.x.x";
  }
  return null; // valid
}

/* ═══════════════════════════════════════════════════════════════
   WEB WORKER — inline blob (heavy AST computation off main thread)
═══════════════════════════════════════════════════════════════ */
const WORKER_SRC = `
let _id = 0;
const uid = () => 'n' + (++_id);

function toAST(val, key, depth) {
  if (val === null) return { id: uid(), key, type: 'null', depth, keyCount: 0, children: [] };
  if (Array.isArray(val)) {
    const children = val.slice(0, 12).map((v, i) => toAST(v, '[' + i + ']', depth + 1));
    return { id: uid(), key, type: 'array', depth, keyCount: val.length, children };
  }
  if (typeof val === 'object') {
    const keys = Object.keys(val).slice(0, 14);
    const children = keys.map(k => toAST(val[k], k, depth + 1));
    return { id: uid(), key, type: 'object', depth, keyCount: keys.length, children };
  }
  return { id: uid(), key, type: 'primitive', depth, keyCount: 0, children: [] };
}

self.onmessage = ({ data: { type, payload, rid } }) => {
  if (type !== 'PARSE_JSON') return;
  try {
    _id = 0;
    const ast = toAST(JSON.parse(payload), 'root', 0);
    self.postMessage({ type: 'AST_RESULT', ast, rid });
  } catch (e) {
    self.postMessage({ type: 'AST_ERROR', msg: e.message, rid });
  }
};
`;

/* ═══════════════════════════════════════════════════════════════
   AUDIO ENGINE  (Web Audio API — full Tone.js-equivalent synthesis)
═══════════════════════════════════════════════════════════════ */
class AudioEngine {
  ctx = null;
  analyser = null;
  masterGain = null;
  liveNodes = [];
  fftData = new Uint8Array(256);

  init() {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.fftData = new Uint8Array(this.analyser.frequencyBinCount);
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.28;
    this.masterGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  kill() {
    this.liveNodes.forEach(n => { try { n.stop(0); } catch {} });
    this.liveNodes = [];
  }

  note(freq, type, amp, t0, t1, dst) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(amp, t0 + 0.032);
    env.gain.linearRampToValueAtTime(0, t1);
    osc.connect(env);
    env.connect(dst || this.masterGain);
    osc.start(t0);
    osc.stop(t1 + 0.06);
    this.liveNodes.push(osc);
  }

  // 2xx — C Major Pentatonic · smooth sine · harmonious & clean
  play2xx() {
    this.kill();
    const t = this.ctx.currentTime;
    [261.63, 293.66, 329.63, 392.00, 440.00, 523.25].forEach((f, i) =>
      this.note(f, 'sine', 0.25, t + i * 0.12, t + i * 0.12 + 1.4)
    );
  }

  // 3xx — Lydian mode · augmented 4th (F#) · ethereal, unresolved
  play3xx() {
    this.kill();
    const t = this.ctx.currentTime;
    const lyd = [261.63, 293.66, 329.63, 369.99, 392.00, 440.00, 493.88];
    [0, 2, 4, 6, 1, 3, 5].forEach((idx, j) =>
      this.note(lyd[idx], 'sine', 0.2, t + j * 0.16, t + j * 0.16 + 0.65)
    );
  }

  // 401/403 — Staccato square + ring modulator · sharp access-denied
  play401() {
    this.kill();
    const ctx = this.ctx, t = ctx.currentTime;
    const car = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const modGain = ctx.createGain();
    const outGain = ctx.createGain();
    car.type = 'square'; car.frequency.value = 110;
    mod.type = 'square'; mod.frequency.value = 440;
    modGain.gain.value = 260;
    mod.connect(modGain); modGain.connect(car.frequency);
    [[0, 0.06], [0.13, 0.19], [0.28, 0.34]].forEach(([s, e]) => {
      outGain.gain.setValueAtTime(0.44, t + s);
      outGain.gain.setValueAtTime(0,    t + e);
    });
    car.connect(outGain); outGain.connect(this.masterGain);
    car.start(t); car.stop(t + 0.5);
    mod.start(t); mod.stop(t + 0.5);
    this.liveNodes.push(car, mod);
  }

  // 404/408 — Dorian scale · heavy reverb delay · spatial, empty, echoing
  play404() {
    this.kill();
    const ctx = this.ctx, t = ctx.currentTime;
    const delay = ctx.createDelay(3.0);
    delay.delayTime.value = 0.55;
    const fb = ctx.createGain(); fb.gain.value = 0.52;
    delay.connect(fb); fb.connect(delay); delay.connect(this.masterGain);
    [146.83, 164.81, 174.61, 196.00, 220.00, 246.94].forEach((f, i) =>
      this.note(f, 'sine', 0.22, t + i * 0.44, t + i * 0.44 + 1.1, delay)
    );
  }

  // 5xx — Diminished scale · waveshaping distortion · aggressive, broken
  play5xx() {
    this.kill();
    const ctx = this.ctx, t = ctx.currentTime;
    const ws = ctx.createWaveShaper();
    const curve = new Float32Array(512);
    for (let i = 0; i < 512; i++) {
      const x = (i * 2) / 512 - 1;
      curve[i] = ((Math.PI + 400) * x) / (Math.PI + 400 * Math.abs(x));
    }
    ws.curve = curve; ws.connect(this.masterGain);
    [261.63, 277.18, 311.13, 329.63, 369.99, 392.00, 415.30, 440.00].forEach((f, i) =>
      this.note(f, 'sawtooth', 0.28, t + i * 0.08, t + i * 0.08 + 0.88, ws)
    );
  }

  playForStatus(code) {
    if (!this.ctx) return;
    if      (code >= 200 && code < 300) this.play2xx();
    else if (code >= 300 && code < 400) this.play3xx();
    else if (code === 401 || code === 403) this.play401();
    else if (code === 404 || code === 408 || code === 0) this.play404();
    else if (code >= 500) this.play5xx();
    else this.play404();
  }

  tick() { if (this.analyser) this.analyser.getByteFrequencyData(this.fftData); }
  get isOn() { return !!this.ctx; }
}

/* ═══════════════════════════════════════════════════════════════
   THREE.JS SCENE HELPERS
═══════════════════════════════════════════════════════════════ */
const ORBIT_COLORS = [0x00e8ff, 0xae4dff, 0xff2b6d, 0x00ffa3, 0xffb300];
const depthColor = d => ORBIT_COLORS[d % ORBIT_COLORS.length];

// Platonic solid geometry for terminal/leaf nodes
function getPlatonicGeo(keyCount) {
  const k = Math.max(keyCount, 1);
  if (k <= 4)  return new THREE.TetrahedronGeometry(0.28);
  if (k <= 6)  return new THREE.BoxGeometry(0.38, 0.38, 0.38);
  if (k <= 8)  return new THREE.OctahedronGeometry(0.28);
  if (k <= 12) return new THREE.DodecahedronGeometry(0.28);
  return new THREE.IcosahedronGeometry(0.28);
}

// Cylinder connecting two 3D points (structural linking lines)
function makeCylinder(from, to, color, opacity) {
  const dir = to.clone().sub(from);
  const len = dir.length();
  if (len < 0.01) return new THREE.Object3D();
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.015, 0.015, len, 6),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity })
  );
  mesh.position.copy(from.clone().add(to).multiplyScalar(0.5));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return mesh;
}

// Orbital node-graph layout from AST (PRD §3.2)
function buildOrbitalGraph(node, pos, group, depth = 0, baseAngle = 0) {
  const RADII = [0, 4.2, 2.5, 1.6];
  const SIZES = [0.74, 0.40, 0.24, 0.15];
  const color = depthColor(depth);
  const isLeaf = node.children.length === 0;

  const geo = depth === 0
    ? new THREE.SphereGeometry(SIZES[0], 32, 32)
    : isLeaf
      ? getPlatonicGeo(node.keyCount)
      : new THREE.SphereGeometry(SIZES[Math.min(depth, 3)], 14, 14);

  const mat = new THREE.MeshPhongMaterial({
    color, emissive: color, emissiveIntensity: 0.38,
    transparent: true, opacity: depth === 0 ? 1.0 : 0.86,
    shininess: 70,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(pos);
  mesh.userData = { baseEI: 0.38, depth };
  group.add(mesh);

  if (isLeaf || depth >= 2) return;

  const step = (Math.PI * 2) / Math.max(node.children.length, 1);
  const tilt = 0.42 * depth;
  const r = RADII[Math.min(depth + 1, 3)];

  node.children.forEach((child, i) => {
    const angle = baseAngle + i * step;
    const childPos = new THREE.Vector3(
      pos.x + r * Math.cos(angle),
      pos.y + r * Math.sin(tilt) * Math.sin(angle + depth * 0.5),
      pos.z + r * Math.cos(tilt) * Math.sin(angle)
    );
    group.add(makeCylinder(pos, childPos, color, 0.44 - depth * 0.1));
    buildOrbitalGraph(child, childPos, group, depth + 1, angle + 0.55);
  });
}

/* ═══════════════════════════════════════════════════════════════
   PRESET ENDPOINTS
═══════════════════════════════════════════════════════════════ */
const PRESETS = [
  { name: "Post",     url: "https://jsonplaceholder.typicode.com/posts/1" },
  { name: "User",     url: "https://jsonplaceholder.typicode.com/users/1" },
  { name: "Comments", url: "https://jsonplaceholder.typicode.com/posts/1/comments" },
  { name: "HTTPBin",  url: "https://httpbin.org/json" },
];

/* ═══════════════════════════════════════════════════════════════
   MAIN COMPONENT
═══════════════════════════════════════════════════════════════ */
export default function ASTonal() {
  // ── Refs (singleton lock pattern per PRD §5) ──
  const mountRef   = useRef(null);
  const rendRef    = useRef(null);
  const frameRef   = useRef(0);
  const dataGrp    = useRef(null);
  const idleGrp    = useRef(null);
  const starsRef   = useRef(null);
  const audioRef   = useRef(new AudioEngine());
  const workerRef  = useRef(null);
  const isInit     = useRef(false);   // React singleton lock
  const running    = useRef(false);
  const dragRef    = useRef({ on: false, x: 0, y: 0 });
  const rotRef     = useRef({ x: 0.14, y: 0 });

  // ── State ──
  const [url,      setUrl]      = useState(PRESETS[0].url);
  const [phase,    setPhase]    = useState("idle");
  const [tele,     setTele]     = useState(null);
  const [err,      setErr]      = useState(null);
  const [astInfo,  setAstInfo]  = useState(null);
  const [hdOpen,   setHdOpen]   = useState(false);
  const [audioOn,  setAudioOn]  = useState(false);
  const [bgTint,   setBgTint]   = useState("transparent");

  // ── Font injection ──
  useEffect(() => {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=JetBrains+Mono:ital,wght@0,400;0,700&display=swap";
    document.head.appendChild(l);
  }, []);

  // ── Three.js init (singleton lock: isInit.current) ──
  useEffect(() => {
    if (isInit.current || !mountRef.current) return;
    isInit.current = true;
    const el = mountRef.current;
    const W = Math.max(el.clientWidth, 480);
    const H = Math.max(el.clientHeight, 360);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor(0x060610);
    el.appendChild(renderer.domElement);
    rendRef.current = renderer;

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x060610, 18, 50);

    const cam = new THREE.PerspectiveCamera(55, W / H, 0.1, 100);
    cam.position.set(0, 0, 10);

    // Lighting
    scene.add(new THREE.AmbientLight(0x0d1833, 0.9));
    const p1 = new THREE.PointLight(0x00e8ff, 2.0, 28);
    p1.position.set(6, 6, 5); scene.add(p1);
    const p2 = new THREE.PointLight(0xae4dff, 1.5, 28);
    p2.position.set(-5, -5, 4); scene.add(p2);

    // Star field
    const sp = new Float32Array(1600 * 3);
    for (let i = 0; i < sp.length; i++) sp[i] = (Math.random() - 0.5) * 90;
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(sp, 3));
    const stars = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({ color: 0x1e2d3d, size: 0.055 })
    );
    scene.add(stars);
    starsRef.current = stars;

    // Idle group: animated molecular structure
    const ig = new THREE.Group();
    ig.add(new THREE.Mesh(
      new THREE.IcosahedronGeometry(2.2, 0),
      new THREE.MeshBasicMaterial({ color: 0x00e8ff, wireframe: true, transparent: true, opacity: 0.09 })
    ));
    const innerMesh = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.36),
      new THREE.MeshPhongMaterial({ color: 0x00e8ff, emissive: 0x00e8ff, emissiveIntensity: 1.0 })
    );
    ig.add(innerMesh);
    const ring1 = new THREE.Mesh(
      new THREE.TorusGeometry(1.35, 0.013, 6, 80),
      new THREE.MeshBasicMaterial({ color: 0xae4dff, transparent: true, opacity: 0.26 })
    );
    ring1.rotation.x = Math.PI / 4;
    ig.add(ring1);
    const ring2 = new THREE.Mesh(
      new THREE.TorusGeometry(1.9, 0.01, 6, 80),
      new THREE.MeshBasicMaterial({ color: 0x00e8ff, transparent: true, opacity: 0.14 })
    );
    ring2.rotation.x = -Math.PI / 3;
    ring2.rotation.y = Math.PI / 5;
    ig.add(ring2);
    scene.add(ig);
    idleGrp.current = ig;

    // Data group (orbital graph)
    const dg = new THREE.Group();
    scene.add(dg);
    dataGrp.current = dg;

    // ── Animation loop ──
    let t = 0;
    function loop() {
      frameRef.current = requestAnimationFrame(loop);
      t += 0.016;

      // Idle animation
      if (ig.visible) {
        ig.rotation.y = t * 0.20;
        ig.rotation.x = Math.sin(t * 0.14) * 0.28;
        innerMesh.scale.setScalar(1 + Math.sin(t * 1.7) * 0.24);
      }

      // Orbital graph: smooth lerp to target rotation
      if (dg.children.length > 0) {
        dg.rotation.y += (rotRef.current.y - dg.rotation.y) * 0.08;
        dg.rotation.x += (rotRef.current.x - dg.rotation.x) * 0.08;
        if (!dragRef.current.on) rotRef.current.y += 0.003;
      }

      // FFT audio-reactive mesh displacement (PRD §3.3)
      audioRef.current.tick();
      const fft = audioRef.current.fftData;
      if (fft.length && dg.children.length) {
        const lo = (fft[1]  + fft[2]  + fft[3])  / (3 * 255);
        const mi = (fft[12] + fft[15] + fft[18]) / (3 * 255);
        const hi = (fft[35] + fft[42] + fft[50]) / (3 * 255);
        dg.children.forEach(obj => {
          if (!(obj instanceof THREE.Mesh)) return;
          const d = obj.userData.depth ?? 0;
          const pulse = d === 0 ? lo : d === 1 ? mi : hi;
          obj.material.emissiveIntensity = 0.38 + pulse * 1.25;
          if (d <= 1) obj.scale.setScalar(1 + pulse * 0.15);
        });
      }

      stars.rotation.y = t * 0.004;
      renderer.render(scene, cam);
    }
    loop();

    const onResize = () => {
      if (!el) return;
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h);
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(frameRef.current);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      try { el.removeChild(renderer.domElement); } catch {}
      isInit.current = false;
    };
  }, []);

  // ── Worker init (inline blob — Next.js native worker syntax simulated) ──
  useEffect(() => {
    const blobUrl = URL.createObjectURL(
      new Blob([WORKER_SRC], { type: "application/javascript" })
    );
    workerRef.current = new Worker(blobUrl);
    return () => {
      workerRef.current?.terminate();
      URL.revokeObjectURL(blobUrl);
    };
  }, []);

  // ── Mouse drag rotation ──
  const onMouseDown = useCallback(e => {
    dragRef.current = { on: true, x: e.clientX, y: e.clientY };
  }, []);
  const onMouseMove = useCallback(e => {
    if (!dragRef.current.on) return;
    rotRef.current.y += (e.clientX - dragRef.current.x) * 0.010;
    rotRef.current.x += (e.clientY - dragRef.current.y) * 0.010;
    dragRef.current.x = e.clientX;
    dragRef.current.y = e.clientY;
  }, []);
  const onMouseUp = useCallback(() => { dragRef.current.on = false; }, []);

  // ── Main analysis flow ──
  const analyze = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setErr(null); setTele(null); setAstInfo(null); setHdOpen(false);

    // STEP 1: SSRF validation
    setPhase("validating");
    const guardErr = ssrfGuard(url);
    if (guardErr) {
      setErr(guardErr); setPhase("error");
      running.current = false; return;
    }

    // STEP 2: Audio gate (browser requires user gesture — PRD §5)
    if (!audioRef.current.isOn) {
      audioRef.current.init();
      setAudioOn(true);
    }

    // STEP 3: Clear scene
    if (idleGrp.current) idleGrp.current.visible = false;
    const dg = dataGrp.current;
    while (dg.children.length) dg.remove(dg.children[0]);

    // STEP 4: Fetch with timing profile (redirect: manual equivalent)
    setPhase("fetching");
    const t0 = performance.now();
    let res;

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      // Note: In a real Edge Runtime proxy, redirect:'manual' would capture 301/302 precisely.
      // Browser fetch follows redirects; we detect via response.redirected.
      const resp = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
      const ttfb = Math.round(performance.now() - t0);
      clearTimeout(timer);
      const body = await resp.text();
      const total = Math.round(performance.now() - t0);
      const headers = [];
      resp.headers.forEach((v, k) => headers.push([k, v]));
      res = {
        url, status: resp.status, statusText: resp.statusText,
        timing: { ttfb, total }, headers,
        redirected: resp.redirected,
        body: body.slice(0, 4096),
        contentType: resp.headers.get("content-type") || "",
        error: null,
      };
    } catch (ex) {
      const total = Math.round(performance.now() - t0);
      const msg = ex instanceof Error ? ex.message : "Unknown network error";
      res = {
        url, status: 0, statusText: "Network / CORS Error",
        timing: { ttfb: 0, total }, headers: [],
        redirected: false, body: "", contentType: "", error: msg,
      };
    }

    setTele(res);
    audioRef.current.playForStatus(res.status);

    // Background tint from status category
    if      (res.status >= 200 && res.status < 300) setBgTint("rgba(0,255,163,.028)");
    else if (res.status >= 300 && res.status < 400) setBgTint("rgba(255,180,0,.028)");
    else if (res.status >= 400 && res.status < 500) setBgTint("rgba(255,43,109,.03)");
    else if (res.status >= 500)                     setBgTint("rgba(255,60,60,.04)");
    else                                            setBgTint("transparent");

    // STEP 5: Parse JSON AST in Web Worker (PRD §1)
    const rawBody = res.body.trim();
    if ((rawBody.startsWith("{") || rawBody.startsWith("[")) && workerRef.current) {
      setPhase("parsing");
      const rid = String(Date.now());
      const astNode = await new Promise(resolve => {
        const w = workerRef.current;
        const handler = e => {
          if (e.data.rid !== rid) return;
          w.removeEventListener("message", handler);
          resolve(e.data.type === "AST_RESULT" ? e.data.ast : null);
        };
        w.addEventListener("message", handler);
        setTimeout(() => resolve(null), 6000);
        w.postMessage({ type: "PARSE_JSON", payload: rawBody, rid });
      });

      // STEP 6: Build orbital geometry (PRD §3)
      if (astNode) {
        setPhase("building");
        let nc = 0, md = 0;
        const count = n => { nc++; md = Math.max(md, n.depth); n.children.forEach(count); };
        count(astNode);
        setAstInfo({ nodes: nc, depth: md, type: astNode.type });
        buildOrbitalGraph(astNode, new THREE.Vector3(0, 0, 0), dg);
      }
    }

    setPhase("done");
    running.current = false;
  }, [url]);

  // ── UI helpers ──
  const badge = s => {
    if (s >= 200 && s < 300) return { c: "#00ffa3", bg: "rgba(0,255,163,.08)" };
    if (s >= 300 && s < 400) return { c: "#ffb300", bg: "rgba(255,180,0,.08)" };
    if (s >= 400 && s < 500) return { c: "#ff2b6d", bg: "rgba(255,43,109,.08)" };
    if (s >= 500)            return { c: "#ff4040", bg: "rgba(255,64,64,.08)"  };
    return                          { c: "#607a8a", bg: "rgba(96,122,138,.08)" };
  };

  const busy = ["fetching","parsing","building"].includes(phase);
  const bd   = tele ? badge(tele.status) : null;
  const PHASE_ICONS = { idle:"◉", validating:"◌", fetching:"↻", parsing:"↻", building:"↻", done:"✓", error:"✕" };

  /* ─────────────────────────────────────────────────────────────
     RENDER
  ───────────────────────────────────────────────────────────── */
  return (
    <div style={{
      width:"100vw", height:"100vh", background:"#060610",
      display:"flex", flexDirection:"column", overflow:"hidden",
      fontFamily:"'JetBrains Mono','Courier New',monospace", color:"#9ab0c4",
    }}>
      {/* Global styles + keyframes */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=JetBrains+Mono:ital,wght@0,400;0,700&display=swap');
        *{box-sizing:border-box;}
        ::-webkit-scrollbar{width:3px;}
        ::-webkit-scrollbar-thumb{background:rgba(0,232,255,.14);border-radius:2px;}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}
        @keyframes slideIn{from{opacity:0;transform:translateX(6px)}to{opacity:1;transform:none}}
        .url-input:focus{border-color:rgba(0,232,255,.55)!important;background:rgba(0,232,255,.05)!important;}
        .analyze-btn:not(:disabled):hover{background:rgba(0,232,255,.18)!important;border-color:rgba(0,232,255,.6)!important;}
        .preset-chip:hover{border-color:rgba(0,232,255,.3)!important;color:#7ab!important;}
        .hdr-toggle:hover{border-color:rgba(0,232,255,.2)!important;}
      `}</style>

      {/* ══ HEADER ═══════════════════════════════════════════════ */}
      <div style={{
        display:"flex", alignItems:"center", gap:12, padding:"9px 18px",
        borderBottom:"1px solid rgba(0,232,255,.1)",
        background:"rgba(4,5,18,.98)", flexShrink:0,
      }}>
        {/* Logo mark */}
        <div style={{
          width:32, height:32, borderRadius:7,
          border:"1px solid rgba(0,232,255,.35)",
          background:"linear-gradient(135deg,rgba(0,232,255,.07),rgba(174,77,255,.07))",
          display:"flex", alignItems:"center", justifyContent:"center",
          fontSize:15, color:"#00e8ff", flexShrink:0,
        }}>◈</div>

        <div>
          <div style={{
            fontFamily:"'Orbitron',sans-serif", fontSize:14,
            fontWeight:900, color:"#00e8ff", letterSpacing:3.5, lineHeight:1,
          }}>ASTONAL</div>
          <div style={{ fontSize:7.5, color:"#253545", letterSpacing:1.6, marginTop:2 }}>
            API TELEMETRY · AST GEOMETRY · SONIC SYNTHESIS
          </div>
        </div>

        <div style={{ flex:1 }} />

        {/* Phase indicator */}
        <div style={{ display:"flex", alignItems:"center", gap:6, fontSize:8.5 }}>
          <span style={{
            display:"inline-block",
            animation: busy ? "spin .8s linear infinite" : undefined,
            color: phase==="done" ? "#00ffa3" : phase==="error" ? "#ff2b6d" : "#00e8ff",
          }}>{PHASE_ICONS[phase]}</span>
          <span style={{ color:"#2e4050", textTransform:"uppercase", letterSpacing:1.2 }}>{phase}</span>
        </div>

        <div style={{
          fontSize:7.5, color:"#1e2d3a", padding:"3px 10px",
          border:"1px solid rgba(0,232,255,.07)", borderRadius:3,
          letterSpacing:0.5,
        }}>EDGE · US-EAST</div>
      </div>

      {/* ══ MAIN AREA ════════════════════════════════════════════ */}
      <div style={{ flex:1, display:"flex", overflow:"hidden", minHeight:0 }}>

        {/* ── CANVAS ────────────────────────────────────────────── */}
        <div
          ref={mountRef}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
          style={{
            flex:"1 1 62%", position:"relative",
            cursor:"crosshair", overflow:"hidden",
            borderRight:"1px solid rgba(0,232,255,.07)", minHeight:300,
          }}
        >
          {/* Background tint (status-reactive) */}
          <div style={{
            position:"absolute", inset:0, background:bgTint,
            pointerEvents:"none", zIndex:1, transition:"background 1.2s ease",
          }} />

          {/* CRT scanlines overlay */}
          <div style={{
            position:"absolute", inset:0, pointerEvents:"none", zIndex:2,
            background:"repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,0,0,.032) 3px,rgba(0,0,0,.032) 4px)",
          }} />

          {/* Corner brackets */}
          {[
            { top:8, left:8,  borderTop:"1px solid rgba(0,232,255,.32)", borderLeft:"1px solid rgba(0,232,255,.32)" },
            { top:8, right:8, borderTop:"1px solid rgba(0,232,255,.32)", borderRight:"1px solid rgba(0,232,255,.32)" },
            { bottom:8, left:8,  borderBottom:"1px solid rgba(0,232,255,.32)", borderLeft:"1px solid rgba(0,232,255,.32)" },
            { bottom:8, right:8, borderBottom:"1px solid rgba(0,232,255,.32)", borderRight:"1px solid rgba(0,232,255,.32)" },
          ].map((s, i) => (
            <div key={i} style={{ position:"absolute", width:16, height:16, pointerEvents:"none", zIndex:3, ...s }} />
          ))}

          {/* Idle pulse hint */}
          {phase === "idle" && (
            <div style={{
              position:"absolute", bottom:22, left:"50%", transform:"translateX(-50%)",
              zIndex:4, pointerEvents:"none", whiteSpace:"nowrap",
              fontSize:8.5, color:"rgba(0,232,255,.22)", letterSpacing:2.5,
              animation:"pulse 2.2s ease-in-out infinite",
            }}>AWAITING TARGET ENDPOINT</div>
          )}

          {/* Drag hint */}
          {phase === "done" && (
            <div style={{
              position:"absolute", bottom:10, left:14, zIndex:4, pointerEvents:"none",
              fontSize:7.5, color:"#1e2d3a", letterSpacing:1,
            }}>DRAG TO ROTATE</div>
          )}

          {/* Processing spinner overlay */}
          {busy && (
            <div style={{
              position:"absolute", inset:0, zIndex:5, pointerEvents:"none",
              display:"flex", alignItems:"center", justifyContent:"center",
              background:"rgba(6,6,16,.42)",
            }}>
              <div style={{ textAlign:"center" }}>
                <div style={{
                  width:38, height:38,
                  border:"2px solid rgba(0,232,255,.1)",
                  borderTop:"2px solid #00e8ff",
                  borderRadius:"50%",
                  animation:"spin .75s linear infinite",
                  margin:"0 auto 10px",
                }} />
                <div style={{ fontSize:8, color:"#00e8ff", letterSpacing:2.5 }}>
                  {phase.toUpperCase()}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── RIGHT CONTROL PANEL ───────────────────────────────── */}
        <div style={{
          width:298, flexShrink:0, display:"flex", flexDirection:"column",
          overflow:"hidden", background:"rgba(5,7,20,.99)",
        }}>
          <div style={{ flex:1, overflowY:"auto", padding:"14px 14px 10px" }}>

            {/* URL Input */}
            <div style={{ marginBottom:10 }}>
              <div style={{ fontSize:7.5, color:"#1e2d3a", letterSpacing:2, marginBottom:5, fontWeight:700 }}>
                TARGET ENDPOINT
              </div>
              <input
                className="url-input"
                value={url}
                onChange={e => setUrl(e.target.value)}
                onKeyDown={e => e.key === "Enter" && analyze()}
                placeholder="https://api.example.com/data"
                style={{
                  width:"100%",
                  background:"rgba(0,232,255,.03)",
                  border:"1px solid rgba(0,232,255,.17)",
                  borderRadius:3, padding:"7px 9px",
                  fontSize:9.5, color:"#c0d4e8",
                  fontFamily:"inherit", outline:"none", transition:"all .2s",
                }}
              />
            </div>

            {/* Presets */}
            <div style={{ marginBottom:12 }}>
              <div style={{ fontSize:7.5, color:"#182430", letterSpacing:2, marginBottom:5 }}>PRESETS</div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
                {PRESETS.map(p => (
                  <button key={p.url} onClick={() => setUrl(p.url)} className="preset-chip"
                    style={{
                      background: url === p.url ? "rgba(0,232,255,.1)" : "transparent",
                      border: `1px solid ${url === p.url ? "rgba(0,232,255,.32)" : "rgba(0,232,255,.08)"}`,
                      color: url === p.url ? "#00e8ff" : "#2e4050",
                      fontSize:7.5, padding:"3px 7px", borderRadius:3,
                      cursor:"pointer", fontFamily:"inherit", letterSpacing:.5,
                      transition:"all .15s",
                    }}>
                    {p.name}
                  </button>
                ))}
              </div>
            </div>

            {/* ── Analyze button (Audio init gate per PRD §5) ── */}
            <button
              onClick={analyze}
              disabled={busy}
              className="analyze-btn"
              style={{
                width:"100%", padding:"10px",
                background: busy ? "rgba(0,232,255,.04)" : "rgba(0,232,255,.08)",
                border:"1px solid rgba(0,232,255,.28)",
                borderRadius:3, color: busy ? "rgba(0,232,255,.35)" : "#00e8ff",
                fontFamily:"'Orbitron',sans-serif",
                fontSize:9, letterSpacing:2.5, fontWeight:700,
                cursor: busy ? "not-allowed" : "pointer",
                transition:"all .2s", marginBottom:12,
              }}
            >
              {busy ? `[ ${phase.toUpperCase()}... ]` : "[ CONNECT & ANALYZE ]"}
            </button>

            {/* Error display */}
            {err && (
              <div style={{
                padding:"7px 9px", borderRadius:3, marginBottom:10,
                background:"rgba(255,43,109,.07)", border:"1px solid rgba(255,43,109,.24)",
                fontSize:8.5, color:"#ff2b6d", animation:"slideIn .2s ease", lineHeight:1.55,
              }}>✕ {err}</div>
            )}

            {/* ── Telemetry Results ── */}
            {tele && (
              <div style={{ animation:"fadeUp .3s ease" }}>

                {/* Status badge */}
                <div style={{ display:"flex", alignItems:"center", gap:9, marginBottom:10 }}>
                  <div style={{
                    padding:"3px 11px", borderRadius:3,
                    fontSize:18, fontWeight:700,
                    fontFamily:"'Orbitron',sans-serif",
                    color: bd.c, background: bd.bg,
                    border:`1px solid ${bd.c}30`,
                    letterSpacing:1, lineHeight:1.6,
                  }}>
                    {tele.status || "ERR"}
                  </div>
                  <div>
                    <div style={{ fontSize:9.5, color:"#c0d4e8", lineHeight:1.3 }}>
                      {tele.statusText}
                    </div>
                    <div style={{ fontSize:7.5, color:"#1e2d3a", marginTop:2 }}>
                      {tele.redirected ? "↪ REDIRECTED" : "DIRECT RESPONSE"}
                    </div>
                  </div>
                </div>

                {/* Timing profile */}
                <div style={{
                  padding:"9px", borderRadius:3, marginBottom:8,
                  background:"rgba(0,232,255,.03)", border:"1px solid rgba(0,232,255,.08)",
                }}>
                  <div style={{ fontSize:7.5, color:"#1e2d3a", letterSpacing:2, marginBottom:7 }}>
                    TIMING PROFILE
                  </div>
                  {[["TTFB", tele.timing.ttfb], ["TOTAL", tele.timing.total]].map(([label, val]) => (
                    <div key={label} style={{ marginBottom:6 }}>
                      <div style={{ display:"flex", justifyContent:"space-between", fontSize:8.5, marginBottom:2.5 }}>
                        <span style={{ color:"#2e4050" }}>{label}</span>
                        <span style={{ color:"#c0d4e8" }}>{val}ms</span>
                      </div>
                      <div style={{ height:2, background:"rgba(0,232,255,.07)", borderRadius:1 }}>
                        <div style={{
                          height:"100%", borderRadius:1,
                          width:`${Math.min(val / 2000, 1) * 100}%`,
                          background: val > 1200 ? "#ff4040" : val > 500 ? "#ffb300" : "#00e8ff",
                          transition:"width .7s ease",
                        }} />
                      </div>
                    </div>
                  ))}
                </div>

                {/* AST geometry stats */}
                {astInfo && (
                  <div style={{
                    padding:"9px", borderRadius:3, marginBottom:8,
                    background:"rgba(174,77,255,.04)", border:"1px solid rgba(174,77,255,.12)",
                  }}>
                    <div style={{ fontSize:7.5, color:"#1e2d3a", letterSpacing:2, marginBottom:7 }}>
                      AST GEOMETRY
                    </div>
                    {[
                      ["ROOT TYPE",  astInfo.type.toUpperCase()],
                      ["TOTAL NODES", String(astInfo.nodes)],
                      ["MAX DEPTH",   String(astInfo.depth)],
                    ].map(([l, v]) => (
                      <div key={l} style={{ display:"flex", justifyContent:"space-between", fontSize:8.5, marginBottom:4 }}>
                        <span style={{ color:"#2e4050" }}>{l}</span>
                        <span style={{ color:"#ae4dff" }}>{v}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Content type */}
                {tele.contentType && (
                  <div style={{ fontSize:7.5, color:"#1e2d3a", marginBottom:8, wordBreak:"break-all" }}>
                    CONTENT-TYPE{" "}
                    <span style={{ color:"#344a5a" }}>{tele.contentType.split(";")[0]}</span>
                  </div>
                )}

                {/* Response headers accordion */}
                {tele.headers.length > 0 && (
                  <div style={{ marginBottom:8 }}>
                    <button
                      onClick={() => setHdOpen(o => !o)}
                      className="hdr-toggle"
                      style={{
                        width:"100%", background:"transparent",
                        border:"1px solid rgba(0,232,255,.08)", borderRadius:3,
                        padding:"5px 9px",
                        display:"flex", justifyContent:"space-between", alignItems:"center",
                        fontSize:7.5, color:"#2e4050", cursor:"pointer",
                        fontFamily:"inherit", letterSpacing:1.5, transition:"border-color .15s",
                      }}>
                      <span>RESPONSE HEADERS ({tele.headers.length})</span>
                      <span style={{ transform: hdOpen ? "rotate(180deg)" : "none", transition:".2s" }}>▾</span>
                    </button>
                    {hdOpen && (
                      <div style={{
                        border:"1px solid rgba(0,232,255,.06)", borderTop:"none",
                        borderRadius:"0 0 3px 3px", maxHeight:160, overflowY:"auto",
                        padding:"6px 9px",
                      }}>
                        {tele.headers.map(([k, v]) => (
                          <div key={k} style={{ marginBottom:5 }}>
                            <div style={{ fontSize:7, color:"#2a3a4a", letterSpacing:.4 }}>{k}</div>
                            <div style={{ fontSize:7.5, color:"#3a5060", wordBreak:"break-all" }}>{v.slice(0, 90)}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* CORS advisory */}
                {tele.error && (
                  <div style={{
                    padding:"7px 9px", borderRadius:3,
                    background:"rgba(255,180,0,.06)", border:"1px solid rgba(255,180,0,.18)",
                    fontSize:7.5, color:"#ffb300", lineHeight:1.65,
                  }}>
                    ⚠ Browser CORS policy restricted the response body. Deploy a server-side proxy
                    (Next.js Edge Runtime) for unrestricted cross-origin profiling.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Audio status bar */}
          <div style={{
            padding:"7px 14px", borderTop:"1px solid rgba(0,232,255,.06)",
            display:"flex", alignItems:"center", gap:7,
            fontSize:7.5, color:"#1a2a38", flexShrink:0,
          }}>
            <span style={{
              color: audioOn ? "#00ffa3" : "#1a2a38",
              animation: audioOn ? "pulse 1.8s ease-in-out infinite" : undefined,
            }}>♪</span>
            <span style={{ letterSpacing:.5 }}>
              {audioOn
                ? "WEB AUDIO ACTIVE · FFT REACTIVE"
                : "AUDIO INITIALIZES ON FIRST ANALYZE"}
            </span>
          </div>
        </div>
      </div>

      {/* ══ FOOTER ═══════════════════════════════════════════════ */}
      <div style={{
        padding:"5px 18px",
        borderTop:"1px solid rgba(0,232,255,.06)",
        display:"flex", justifyContent:"space-between", alignItems:"center",
        flexShrink:0, background:"rgba(4,5,18,.98)",
      }}>
        <span style={{ fontSize:7.5, color:"#182430", letterSpacing:.4 }}>
          Telemetry measured via Vercel Edge Network (US-East) to Target Origin
        </span>
        <span style={{ fontSize:7.5, color:"#182430" }}>ASTONAL v1.0</span>
      </div>
    </div>
  );
}
