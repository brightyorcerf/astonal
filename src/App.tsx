import { useState, useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { gsap } from 'gsap';
import type {
  TelemetryResult,
  ASTInfo,
  OrbitalGraph,
  WorkerInboundMessage,
  WorkerOutboundMessage,
} from './types/worker-contracts';

/* ═══════════════════════════════════════════════════════════════
   SSRF GUARD  (client-side mirror of proxy validation — PRD §2.1)
   Server-side check in vite.config.ts is authoritative; this
   gives instant feedback before the network round-trip.
═══════════════════════════════════════════════════════════════ */
function ssrfGuard(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'Malformed URL — cannot parse'; }
  if (!/^https?:$/.test(u.protocol)) return 'Only HTTP / HTTPS allowed';
  const h = u.hostname.toLowerCase();
  const deny = ['localhost','127.0.0.1','0.0.0.0','::1','169.254.169.254','::ffff:169.254.169.254'];
  if (deny.includes(h)) return `SSRF blocked: ${h}`;
  const m = h.match(/^(\d+)\.(\d+)/);
  if (m) {
    const [a, b] = [+m[1], +m[2]];
    if (a === 10) return 'RFC 1918 blocked: 10.x.x.x';
    if (a === 172 && b >= 16 && b <= 31) return 'RFC 1918 blocked: 172.16–31.x.x';
    if (a === 192 && b === 168) return 'RFC 1918 blocked: 192.168.x.x';
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════
   AUDIO ENGINE  (Web Audio API — full Tone.js-equivalent synthesis)
   PRD §4 — each HTTP status class maps to a distinct modal profile
═══════════════════════════════════════════════════════════════ */
class AudioEngine {
  ctx: AudioContext | null = null;
  analyser: AnalyserNode | null = null;
  masterGain: GainNode | null = null;
  liveNodes: OscillatorNode[] = [];
  fftData: Uint8Array = new Uint8Array(256);

  init(): void {
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

  kill(): void {
    this.liveNodes.forEach(n => { try { n.stop(0); } catch { /* already stopped */ } });
    this.liveNodes = [];
  }

  note(
    freq: number, type: OscillatorType, amp: number,
    t0: number, t1: number, dst?: AudioNode,
  ): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(amp, t0 + 0.032);
    env.gain.linearRampToValueAtTime(0, t1);
    osc.connect(env);
    env.connect(dst ?? this.masterGain!);
    osc.start(t0);
    osc.stop(t1 + 0.06);
    this.liveNodes.push(osc);
  }

  // 2xx — C Major Pentatonic · smooth sine · harmonious & clean
  play2xx(): void {
    this.kill();
    const t = this.ctx!.currentTime;
    [261.63, 293.66, 329.63, 392.00, 440.00, 523.25].forEach((f, i) =>
      this.note(f, 'sine', 0.25, t + i * 0.12, t + i * 0.12 + 1.4)
    );
  }

  // 3xx — Lydian mode · augmented 4th (F#) · ethereal, unresolved
  play3xx(): void {
    this.kill();
    const t = this.ctx!.currentTime;
    const lyd = [261.63, 293.66, 329.63, 369.99, 392.00, 440.00, 493.88];
    [0, 2, 4, 6, 1, 3, 5].forEach((idx, j) =>
      this.note(lyd[idx], 'sine', 0.2, t + j * 0.16, t + j * 0.16 + 0.65)
    );
  }

  // 401/403 — Staccato square + ring modulator · sharp access-denied
  play401(): void {
    this.kill();
    const ctx = this.ctx!, t = ctx.currentTime;
    const car = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const modGain = ctx.createGain();
    const outGain = ctx.createGain();
    car.type = 'square'; car.frequency.value = 110;
    mod.type = 'square'; mod.frequency.value = 440;
    modGain.gain.value = 260;
    mod.connect(modGain); modGain.connect(car.frequency);
    ([[0, 0.06], [0.13, 0.19], [0.28, 0.34]] as [number, number][]).forEach(([s, e]) => {
      outGain.gain.setValueAtTime(0.44, t + s);
      outGain.gain.setValueAtTime(0,    t + e);
    });
    car.connect(outGain); outGain.connect(this.masterGain!);
    car.start(t); car.stop(t + 0.5);
    mod.start(t); mod.stop(t + 0.5);
    this.liveNodes.push(car, mod);
  }

  // 404/408 — Dorian scale · heavy reverb delay · spatial, empty, echoing
  play404(): void {
    this.kill();
    const ctx = this.ctx!, t = ctx.currentTime;
    const delay = ctx.createDelay(3.0);
    delay.delayTime.value = 0.55;
    const fb = ctx.createGain(); fb.gain.value = 0.52;
    delay.connect(fb); fb.connect(delay); delay.connect(this.masterGain!);
    [146.83, 164.81, 174.61, 196.00, 220.00, 246.94].forEach((f, i) =>
      this.note(f, 'sine', 0.22, t + i * 0.44, t + i * 0.44 + 1.1, delay)
    );
  }

  // 5xx — Diminished scale · waveshaping distortion · aggressive, broken
  play5xx(): void {
    this.kill();
    const ctx = this.ctx!, t = ctx.currentTime;
    const ws = ctx.createWaveShaper();
    const curve = new Float32Array(512);
    for (let i = 0; i < 512; i++) {
      const x = (i * 2) / 512 - 1;
      curve[i] = ((Math.PI + 400) * x) / (Math.PI + 400 * Math.abs(x));
    }
    ws.curve = curve; ws.connect(this.masterGain!);
    [261.63, 277.18, 311.13, 329.63, 369.99, 392.00, 415.30, 440.00].forEach((f, i) =>
      this.note(f, 'sawtooth', 0.28, t + i * 0.08, t + i * 0.08 + 0.88, ws)
    );
  }

  playForStatus(code: number): void {
    if (!this.ctx) return;
    if      (code >= 200 && code < 300) this.play2xx();
    else if (code >= 300 && code < 400) this.play3xx();
    else if (code === 401 || code === 403) this.play401();
    else if (code === 404 || code === 408 || code === 0) this.play404();
    else if (code >= 500) this.play5xx();
    else this.play404();
  }

  tick(): void { if (this.analyser) this.analyser.getByteFrequencyData(this.fftData); }
  get isOn(): boolean { return !!this.ctx; }
}

/* ═══════════════════════════════════════════════════════════════
   THREE.JS SCENE HELPERS
═══════════════════════════════════════════════════════════════ */
const ORBIT_COLORS: number[] = [0x00e8ff, 0xae4dff, 0xff2b6d, 0x00ffa3, 0xffb300];
const depthColor = (d: number): number => ORBIT_COLORS[d % ORBIT_COLORS.length];

// Platonic solid selection + N-sided prism fallback (PRD §3.1)
function getPlatonicGeo(keyCount: number): THREE.BufferGeometry {
  const k = Math.max(keyCount, 1);
  if (k <= 4)  return new THREE.TetrahedronGeometry(0.28);
  if (k <= 6)  return new THREE.BoxGeometry(0.38, 0.38, 0.38);
  if (k <= 8)  return new THREE.OctahedronGeometry(0.28);
  if (k <= 12) return new THREE.DodecahedronGeometry(0.28);
  if (k <= 20) return new THREE.IcosahedronGeometry(0.28);
  // k > 20: N-sided extruded prism where N = key count (PRD §3.1 fallback)
  return new THREE.CylinderGeometry(0.28, 0.28, 0.38, Math.min(k, 32), 1);
}

// Cylinder connecting two 3D points (structural linking lines)
function makeCylinder(
  from: THREE.Vector3, to: THREE.Vector3,
  color: number, opacity: number,
): THREE.Object3D {
  const dir = to.clone().sub(from);
  const len = dir.length();
  if (len < 0.01) return new THREE.Object3D();
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.015, 0.015, len, 6),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity }),
  );
  mesh.position.copy(from.clone().add(to).multiplyScalar(0.5));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return mesh;
}

// Build Three.js meshes from worker-computed layout data (PRD §1 — main thread
// is responsible ONLY for GL object instantiation, not coordinate math)
function buildMeshesFromGraph(graph: OrbitalGraph, group: THREE.Group): void {
  const SIZES = [0.74, 0.40, 0.24, 0.15] as const;

  // Edges first — render behind nodes
  graph.edges.forEach(({ from, to, depth }) => {
    group.add(makeCylinder(
      new THREE.Vector3(from.x, from.y, from.z),
      new THREE.Vector3(to.x, to.y, to.z),
      depthColor(depth),
      0.44 - depth * 0.1,
    ));
  });

  // Nodes
  graph.nodes.forEach(({ depth, keyCount, isLeaf, pos }) => {
    const color = depthColor(depth);
    const geo = depth === 0
      ? new THREE.SphereGeometry(SIZES[0], 32, 32)
      : isLeaf
        ? getPlatonicGeo(keyCount)
        : new THREE.SphereGeometry(SIZES[Math.min(depth, 3)], 14, 14);
    const mat = new THREE.MeshPhongMaterial({
      color, emissive: color, emissiveIntensity: 0.38,
      transparent: true, opacity: depth === 0 ? 1.0 : 0.86,
      shininess: 70,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pos.x, pos.y, pos.z);
    mesh.userData = { baseEI: 0.38, depth };
    group.add(mesh);
  });
}

/* ═══════════════════════════════════════════════════════════════
   PRESET ENDPOINTS
═══════════════════════════════════════════════════════════════ */
const PRESETS = [
  { name: 'Post',     url: 'https://jsonplaceholder.typicode.com/posts/1' },
  { name: 'User',     url: 'https://jsonplaceholder.typicode.com/users/1' },
  { name: 'Comments', url: 'https://jsonplaceholder.typicode.com/posts/1/comments' },
  { name: 'HTTPBin',  url: 'https://httpbin.org/json' },
] as const;

type Phase = 'idle' | 'validating' | 'fetching' | 'parsing' | 'building' | 'done' | 'error';

/* ═══════════════════════════════════════════════════════════════
   MAIN COMPONENT
═══════════════════════════════════════════════════════════════ */
export default function ASTonal() {
  // ── Refs (singleton lock pattern — PRD §5) ──────────────────────────────
  const mountRef  = useRef<HTMLDivElement>(null);
  const rendRef   = useRef<THREE.WebGLRenderer | null>(null);
  const frameRef  = useRef<number>(0);
  const dataGrp   = useRef<THREE.Group | null>(null);
  const idleGrp   = useRef<THREE.Group | null>(null);
  const audioRef  = useRef<AudioEngine>(new AudioEngine());
  const workerRef = useRef<Worker | null>(null);
  const isInit    = useRef<boolean>(false);
  const running   = useRef<boolean>(false);
  const dragRef   = useRef<{ on: boolean; x: number; y: number }>({ on: false, x: 0, y: 0 });
  const rotRef    = useRef<{ x: number; y: number }>({ x: 0.14, y: 0 });

  // ── GSAP animation targets ───────────────────────────────────────────────
  const teleRef = useRef<HTMLDivElement>(null);
  const errRef  = useRef<HTMLDivElement>(null);
  const astRef  = useRef<HTMLDivElement>(null);

  // ── State ────────────────────────────────────────────────────────────────
  const [url,     setUrl]     = useState<string>(PRESETS[0].url);
  const [phase,   setPhase]   = useState<Phase>('idle');
  const [tele,    setTele]    = useState<TelemetryResult | null>(null);
  const [err,     setErr]     = useState<string | null>(null);
  const [astInfo, setAstInfo] = useState<ASTInfo | null>(null);
  const [hdOpen,  setHdOpen]  = useState<boolean>(false);
  const [audioOn, setAudioOn] = useState<boolean>(false);
  const [bgTint,  setBgTint]  = useState<string>('transparent');

  // ── GSAP entrance animations (fire after React re-renders the element) ──
  useEffect(() => {
    if (tele && teleRef.current) {
      gsap.fromTo(teleRef.current,
        { opacity: 0, y: 8 },
        { opacity: 1, y: 0, duration: 0.35, ease: 'power2.out' },
      );
    }
  }, [tele]);

  useEffect(() => {
    if (err && errRef.current) {
      gsap.fromTo(errRef.current,
        { opacity: 0, x: 6 },
        { opacity: 1, x: 0, duration: 0.2, ease: 'power2.out' },
      );
    }
  }, [err]);

  useEffect(() => {
    if (astInfo && astRef.current) {
      gsap.fromTo(astRef.current,
        { opacity: 0, x: 5 },
        { opacity: 1, x: 0, duration: 0.25, ease: 'power2.out' },
      );
    }
  }, [astInfo]);

  // ── Font injection ───────────────────────────────────────────────────────
  useEffect(() => {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=JetBrains+Mono:ital,wght@0,400;0,700&display=swap';
    document.head.appendChild(l);
  }, []);

  // ── Three.js init (singleton lock — PRD §5) ─────────────────────────────
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

    scene.add(new THREE.AmbientLight(0x0d1833, 0.9));
    const p1 = new THREE.PointLight(0x00e8ff, 2.0, 28); p1.position.set(6, 6, 5); scene.add(p1);
    const p2 = new THREE.PointLight(0xae4dff, 1.5, 28); p2.position.set(-5, -5, 4); scene.add(p2);

    // Star field
    const sp = new Float32Array(1600 * 3);
    for (let i = 0; i < sp.length; i++) sp[i] = (Math.random() - 0.5) * 90;
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    const stars = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({ color: 0x1e2d3d, size: 0.055 }),
    );
    scene.add(stars);

    // Idle group: animated molecular structure
    const ig = new THREE.Group();
    ig.add(new THREE.Mesh(
      new THREE.IcosahedronGeometry(2.2, 0),
      new THREE.MeshBasicMaterial({ color: 0x00e8ff, wireframe: true, transparent: true, opacity: 0.09 }),
    ));
    const innerMesh = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.36),
      new THREE.MeshPhongMaterial({ color: 0x00e8ff, emissive: 0x00e8ff, emissiveIntensity: 1.0 }),
    );
    ig.add(innerMesh);
    const ring1 = new THREE.Mesh(
      new THREE.TorusGeometry(1.35, 0.013, 6, 80),
      new THREE.MeshBasicMaterial({ color: 0xae4dff, transparent: true, opacity: 0.26 }),
    );
    ring1.rotation.x = Math.PI / 4;
    ig.add(ring1);
    const ring2 = new THREE.Mesh(
      new THREE.TorusGeometry(1.9, 0.01, 6, 80),
      new THREE.MeshBasicMaterial({ color: 0x00e8ff, transparent: true, opacity: 0.14 }),
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

    // Animation loop
    let t = 0;
    function loop() {
      frameRef.current = requestAnimationFrame(loop);
      t += 0.016;

      if (ig.visible) {
        ig.rotation.y = t * 0.20;
        ig.rotation.x = Math.sin(t * 0.14) * 0.28;
        innerMesh.scale.setScalar(1 + Math.sin(t * 1.7) * 0.24);
      }

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
          const d = (obj.userData as { depth: number }).depth ?? 0;
          const pulse = d === 0 ? lo : d === 1 ? mi : hi;
          (obj.material as THREE.MeshPhongMaterial).emissiveIntensity = 0.38 + pulse * 1.25;
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
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(frameRef.current);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      try { el.removeChild(renderer.domElement); } catch { /* already detached */ }
      isInit.current = false;
    };
  }, []);

  // ── Worker init — native URL syntax (PRD §5) ────────────────────────────
  useEffect(() => {
    workerRef.current = new Worker(
      new URL('./workers/ast.worker.ts', import.meta.url),
      { type: 'module' },
    );
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  // ── Mouse drag rotation ──────────────────────────────────────────────────
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragRef.current = { on: true, x: e.clientX, y: e.clientY };
  }, []);
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragRef.current.on) return;
    rotRef.current.y += (e.clientX - dragRef.current.x) * 0.010;
    rotRef.current.x += (e.clientY - dragRef.current.y) * 0.010;
    dragRef.current.x = e.clientX;
    dragRef.current.y = e.clientY;
  }, []);
  const onMouseUp = useCallback(() => { dragRef.current.on = false; }, []);

  // ── Main analysis flow ───────────────────────────────────────────────────
  const analyze = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setErr(null); setTele(null); setAstInfo(null); setHdOpen(false);

    try {
      // STEP 1: Client-side SSRF guard
      setPhase('validating');
      const guardErr = ssrfGuard(url);
      if (guardErr) {
        setErr(guardErr); setPhase('error');
        return;
      }

      // STEP 2: Audio gate — browser requires user gesture (PRD §5)
      if (!audioRef.current.isOn) {
        audioRef.current.init();
        setAudioOn(true);
      }

      // STEP 3: Clear scene and dispose GPU resources (fixes geometry memory leak)
      if (idleGrp.current) idleGrp.current.visible = false;
      const dg = dataGrp.current!;
      dg.children.forEach(obj => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
          else obj.material.dispose();
        }
      });
      while (dg.children.length) dg.remove(dg.children[0]);

      // STEP 4: Proxy fetch — PRD §2 backend handles redirect:manual, rate limit, SSRF
      setPhase('fetching');
      let res: TelemetryResult;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 14_000);

      try {
        const proxyResp = await fetch('/api/telemetry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);

        if (proxyResp.status === 429 || proxyResp.status === 400) {
          const { error } = (await proxyResp.json()) as { error: string };
          setErr(error); setPhase('error');
          return;
        }

        const payload = (await proxyResp.json()) as Omit<TelemetryResult, 'url'>;
        res = { ...payload, url };
      } catch (ex) {
        clearTimeout(timer);
        res = {
          url,
          status: (ex as Error).name === 'AbortError' ? 408 : 0,
          statusText: (ex as Error).name === 'AbortError' ? 'Request Timeout' : 'Network Error',
          timing: { ttfb: 0, total: 0 },
          headers: [], redirected: false, redirectLocation: null,
          body: '', contentType: '',
          error: ex instanceof Error ? ex.message : 'Unknown error',
        };
      }

      setTele(res);
      audioRef.current.playForStatus(res.status);

      if      (res.status >= 200 && res.status < 300) setBgTint('rgba(0,255,163,.028)');
      else if (res.status >= 300 && res.status < 400) setBgTint('rgba(255,180,0,.028)');
      else if (res.status >= 400 && res.status < 500) setBgTint('rgba(255,43,109,.03)');
      else if (res.status >= 500)                     setBgTint('rgba(255,60,60,.04)');
      else                                            setBgTint('transparent');

      // STEP 5: Parse JSON + compute orbital layout in Web Worker (PRD §1)
      // Worker handles both AST generation AND coordinate calculations —
      // main thread receives pre-computed positions, does only GL instantiation.
      const rawBody = res.body.trim();
      if ((rawBody.startsWith('{') || rawBody.startsWith('[')) && workerRef.current) {
        setPhase('parsing');
        // Use composite rid to avoid Date.now() collisions (PRD §5 correctness)
        const rid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

        const graph = await new Promise<OrbitalGraph | null>(resolve => {
          const w = workerRef.current!;
          const handler = (e: MessageEvent<WorkerOutboundMessage>) => {
            if (e.data.rid !== rid) return;
            w.removeEventListener('message', handler);
            resolve(e.data.type === 'AST_RESULT' ? e.data.graph : null);
          };
          w.addEventListener('message', handler);
          setTimeout(() => resolve(null), 6_000);
          const msg: WorkerInboundMessage = { type: 'PARSE_JSON', payload: rawBody, rid };
          w.postMessage(msg);
        });

        // STEP 6: Build Three.js meshes from worker-computed positions
        if (graph) {
          setPhase('building');
          setAstInfo({ nodes: graph.totalNodes, depth: graph.maxDepth, type: graph.rootType });
          buildMeshesFromGraph(graph, dg);
        }
      }

      setPhase('done');
    } finally {
      // try/finally ensures running.current resets even if an unexpected throw occurs
      running.current = false;
    }
  }, [url]);

  // ── UI helpers ───────────────────────────────────────────────────────────
  const badge = (s: number): { c: string; bg: string } => {
    if (s >= 200 && s < 300) return { c: '#00ffa3', bg: 'rgba(0,255,163,.08)' };
    if (s >= 300 && s < 400) return { c: '#ffb300', bg: 'rgba(255,180,0,.08)' };
    if (s >= 400 && s < 500) return { c: '#ff2b6d', bg: 'rgba(255,43,109,.08)' };
    if (s >= 500)            return { c: '#ff4040', bg: 'rgba(255,64,64,.08)'  };
    return                          { c: '#607a8a', bg: 'rgba(96,122,138,.08)' };
  };

  const busy = (['fetching', 'parsing', 'building'] as Phase[]).includes(phase);
  const bd   = tele ? badge(tele.status) : null;
  const PHASE_ICONS: Record<Phase, string> = {
    idle: '◉', validating: '◌', fetching: '↻', parsing: '↻',
    building: '↻', done: '✓', error: '✕',
  };

  /* ─────────────────────────────────────────────────────────────
     RENDER
  ───────────────────────────────────────────────────────────── */
  return (
    <div style={{
      width: '100vw', height: '100vh', background: '#060610',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      fontFamily: "'JetBrains Mono','Courier New',monospace", color: '#9ab0c4',
    }}>
      {/* Global styles + keyframes — spin/pulse kept as CSS; entrance animations via GSAP */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=JetBrains+Mono:ital,wght@0,400;0,700&display=swap');
        *{box-sizing:border-box;}
        ::-webkit-scrollbar{width:3px;}
        ::-webkit-scrollbar-thumb{background:rgba(0,232,255,.14);border-radius:2px;}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
        .url-input:focus{border-color:rgba(0,232,255,.55)!important;background:rgba(0,232,255,.05)!important;}
        .analyze-btn:not(:disabled):hover{background:rgba(0,232,255,.18)!important;border-color:rgba(0,232,255,.6)!important;}
        .preset-chip:hover{border-color:rgba(0,232,255,.3)!important;color:#7ab!important;}
        .hdr-toggle:hover{border-color:rgba(0,232,255,.2)!important;}
      `}</style>

      {/* ══ HEADER ═══════════════════════════════════════════════ */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '9px 18px',
        borderBottom: '1px solid rgba(0,232,255,.1)',
        background: 'rgba(4,5,18,.98)', flexShrink: 0,
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: 7,
          border: '1px solid rgba(0,232,255,.35)',
          background: 'linear-gradient(135deg,rgba(0,232,255,.07),rgba(174,77,255,.07))',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 15, color: '#00e8ff', flexShrink: 0,
        }}>◈</div>

        <div>
          <div style={{
            fontFamily: "'Orbitron',sans-serif", fontSize: 14,
            fontWeight: 900, color: '#00e8ff', letterSpacing: 3.5, lineHeight: 1,
          }}>ASTONAL</div>
          <div style={{ fontSize: 7.5, color: '#253545', letterSpacing: 1.6, marginTop: 2 }}>
            API TELEMETRY · AST GEOMETRY · SONIC SYNTHESIS
          </div>
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 8.5 }}>
          <span style={{
            display: 'inline-block',
            animation: busy ? 'spin .8s linear infinite' : undefined,
            color: phase === 'done' ? '#00ffa3' : phase === 'error' ? '#ff2b6d' : '#00e8ff',
          }}>{PHASE_ICONS[phase]}</span>
          <span style={{ color: '#2e4050', textTransform: 'uppercase', letterSpacing: 1.2 }}>{phase}</span>
        </div>

        <div style={{
          fontSize: 7.5, color: '#1e2d3a', padding: '3px 10px',
          border: '1px solid rgba(0,232,255,.07)', borderRadius: 3, letterSpacing: 0.5,
        }}>EDGE · US-EAST</div>
      </div>

      {/* ══ MAIN AREA ════════════════════════════════════════════ */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>

        {/* ── CANVAS ────────────────────────────────────────────── */}
        <div
          ref={mountRef}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
          style={{
            flex: '1 1 62%', position: 'relative',
            cursor: 'crosshair', overflow: 'hidden',
            borderRight: '1px solid rgba(0,232,255,.07)', minHeight: 300,
          }}
        >
          <div style={{
            position: 'absolute', inset: 0, background: bgTint,
            pointerEvents: 'none', zIndex: 1, transition: 'background 1.2s ease',
          }} />
          <div style={{
            position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 2,
            background: 'repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,0,0,.032) 3px,rgba(0,0,0,.032) 4px)',
          }} />
          {[
            { top: 8, left: 8,  borderTop: '1px solid rgba(0,232,255,.32)', borderLeft: '1px solid rgba(0,232,255,.32)' },
            { top: 8, right: 8, borderTop: '1px solid rgba(0,232,255,.32)', borderRight: '1px solid rgba(0,232,255,.32)' },
            { bottom: 8, left: 8,  borderBottom: '1px solid rgba(0,232,255,.32)', borderLeft: '1px solid rgba(0,232,255,.32)' },
            { bottom: 8, right: 8, borderBottom: '1px solid rgba(0,232,255,.32)', borderRight: '1px solid rgba(0,232,255,.32)' },
          ].map((s, i) => (
            <div key={i} style={{ position: 'absolute', width: 16, height: 16, pointerEvents: 'none', zIndex: 3, ...s }} />
          ))}

          {phase === 'idle' && (
            <div style={{
              position: 'absolute', bottom: 22, left: '50%', transform: 'translateX(-50%)',
              zIndex: 4, pointerEvents: 'none', whiteSpace: 'nowrap',
              fontSize: 8.5, color: 'rgba(0,232,255,.22)', letterSpacing: 2.5,
              animation: 'pulse 2.2s ease-in-out infinite',
            }}>AWAITING TARGET ENDPOINT</div>
          )}

          {phase === 'done' && (
            <div style={{
              position: 'absolute', bottom: 10, left: 14, zIndex: 4, pointerEvents: 'none',
              fontSize: 7.5, color: '#1e2d3a', letterSpacing: 1,
            }}>DRAG TO ROTATE</div>
          )}

          {busy && (
            <div style={{
              position: 'absolute', inset: 0, zIndex: 5, pointerEvents: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(6,6,16,.42)',
            }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{
                  width: 38, height: 38,
                  border: '2px solid rgba(0,232,255,.1)',
                  borderTop: '2px solid #00e8ff',
                  borderRadius: '50%',
                  animation: 'spin .75s linear infinite',
                  margin: '0 auto 10px',
                }} />
                <div style={{ fontSize: 8, color: '#00e8ff', letterSpacing: 2.5 }}>
                  {phase.toUpperCase()}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── RIGHT CONTROL PANEL ───────────────────────────────── */}
        <div style={{
          width: 298, flexShrink: 0, display: 'flex', flexDirection: 'column',
          overflow: 'hidden', background: 'rgba(5,7,20,.99)',
        }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: '14px 14px 10px' }}>

            {/* URL Input */}
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 7.5, color: '#1e2d3a', letterSpacing: 2, marginBottom: 5, fontWeight: 700 }}>
                TARGET ENDPOINT
              </div>
              <input
                className="url-input"
                value={url}
                onChange={e => setUrl(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && void analyze()}
                placeholder="https://api.example.com/data"
                style={{
                  width: '100%',
                  background: 'rgba(0,232,255,.03)',
                  border: '1px solid rgba(0,232,255,.17)',
                  borderRadius: 3, padding: '7px 9px',
                  fontSize: 9.5, color: '#c0d4e8',
                  fontFamily: 'inherit', outline: 'none', transition: 'all .2s',
                }}
              />
            </div>

            {/* Presets */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 7.5, color: '#182430', letterSpacing: 2, marginBottom: 5 }}>PRESETS</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {PRESETS.map(p => (
                  <button key={p.url} onClick={() => setUrl(p.url)} className="preset-chip"
                    style={{
                      background: url === p.url ? 'rgba(0,232,255,.1)' : 'transparent',
                      border: `1px solid ${url === p.url ? 'rgba(0,232,255,.32)' : 'rgba(0,232,255,.08)'}`,
                      color: url === p.url ? '#00e8ff' : '#2e4050',
                      fontSize: 7.5, padding: '3px 7px', borderRadius: 3,
                      cursor: 'pointer', fontFamily: 'inherit', letterSpacing: .5,
                      transition: 'all .15s',
                    }}>
                    {p.name}
                  </button>
                ))}
              </div>
            </div>

            {/* Analyze button — audio init gate (PRD §5) */}
            <button
              onClick={() => void analyze()}
              disabled={busy}
              className="analyze-btn"
              style={{
                width: '100%', padding: '10px',
                background: busy ? 'rgba(0,232,255,.04)' : 'rgba(0,232,255,.08)',
                border: '1px solid rgba(0,232,255,.28)',
                borderRadius: 3, color: busy ? 'rgba(0,232,255,.35)' : '#00e8ff',
                fontFamily: "'Orbitron',sans-serif",
                fontSize: 9, letterSpacing: 2.5, fontWeight: 700,
                cursor: busy ? 'not-allowed' : 'pointer',
                transition: 'all .2s', marginBottom: 12,
              }}
            >
              {busy ? `[ ${phase.toUpperCase()}... ]` : '[ CONNECT & ANALYZE ]'}
            </button>

            {/* Error display — entrance animated by GSAP (replaces CSS slideIn) */}
            {err && (
              <div ref={errRef} style={{
                padding: '7px 9px', borderRadius: 3, marginBottom: 10,
                background: 'rgba(255,43,109,.07)', border: '1px solid rgba(255,43,109,.24)',
                fontSize: 8.5, color: '#ff2b6d', lineHeight: 1.55,
              }}>✕ {err}</div>
            )}

            {/* ── Telemetry Results — entrance animated by GSAP (replaces CSS fadeUp) ── */}
            {tele && (
              <div ref={teleRef}>

                {/* Status badge */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 10 }}>
                  <div style={{
                    padding: '3px 11px', borderRadius: 3,
                    fontSize: 18, fontWeight: 700,
                    fontFamily: "'Orbitron',sans-serif",
                    color: bd!.c, background: bd!.bg,
                    border: `1px solid ${bd!.c}30`,
                    letterSpacing: 1, lineHeight: 1.6,
                  }}>
                    {tele.status || 'ERR'}
                  </div>
                  <div>
                    <div style={{ fontSize: 9.5, color: '#c0d4e8', lineHeight: 1.3 }}>
                      {tele.statusText}
                    </div>
                    <div style={{ fontSize: 7.5, color: '#1e2d3a', marginTop: 2 }}>
                      {tele.redirected
                        ? `↪ REDIRECTED${tele.redirectLocation ? ` → ${tele.redirectLocation.slice(0, 30)}` : ''}`
                        : 'DIRECT RESPONSE'}
                    </div>
                  </div>
                </div>

                {/* Timing profile */}
                <div style={{
                  padding: '9px', borderRadius: 3, marginBottom: 8,
                  background: 'rgba(0,232,255,.03)', border: '1px solid rgba(0,232,255,.08)',
                }}>
                  <div style={{ fontSize: 7.5, color: '#1e2d3a', letterSpacing: 2, marginBottom: 7 }}>
                    TIMING PROFILE
                  </div>
                  {([['TTFB', tele.timing.ttfb], ['TOTAL', tele.timing.total]] as [string, number][]).map(([label, val]) => (
                    <div key={label} style={{ marginBottom: 6 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8.5, marginBottom: 2.5 }}>
                        <span style={{ color: '#2e4050' }}>{label}</span>
                        <span style={{ color: '#c0d4e8' }}>{val}ms</span>
                      </div>
                      <div style={{ height: 2, background: 'rgba(0,232,255,.07)', borderRadius: 1 }}>
                        <div style={{
                          height: '100%', borderRadius: 1,
                          width: `${Math.min(val / 2000, 1) * 100}%`,
                          background: val > 1200 ? '#ff4040' : val > 500 ? '#ffb300' : '#00e8ff',
                          transition: 'width .7s ease',
                        }} />
                      </div>
                    </div>
                  ))}
                </div>

                {/* AST geometry stats — entrance animated by GSAP */}
                {astInfo && (
                  <div ref={astRef} style={{
                    padding: '9px', borderRadius: 3, marginBottom: 8,
                    background: 'rgba(174,77,255,.04)', border: '1px solid rgba(174,77,255,.12)',
                  }}>
                    <div style={{ fontSize: 7.5, color: '#1e2d3a', letterSpacing: 2, marginBottom: 7 }}>
                      AST GEOMETRY
                    </div>
                    {([
                      ['ROOT TYPE',   astInfo.type.toUpperCase()],
                      ['TOTAL NODES', String(astInfo.nodes)],
                      ['MAX DEPTH',   String(astInfo.depth)],
                    ] as [string, string][]).map(([l, v]) => (
                      <div key={l} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8.5, marginBottom: 4 }}>
                        <span style={{ color: '#2e4050' }}>{l}</span>
                        <span style={{ color: '#ae4dff' }}>{v}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Content type */}
                {tele.contentType && (
                  <div style={{ fontSize: 7.5, color: '#1e2d3a', marginBottom: 8, wordBreak: 'break-all' }}>
                    CONTENT-TYPE{' '}
                    <span style={{ color: '#344a5a' }}>{tele.contentType.split(';')[0]}</span>
                  </div>
                )}

                {/* Response headers accordion */}
                {tele.headers.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <button
                      onClick={() => setHdOpen(o => !o)}
                      className="hdr-toggle"
                      style={{
                        width: '100%', background: 'transparent',
                        border: '1px solid rgba(0,232,255,.08)', borderRadius: 3,
                        padding: '5px 9px',
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        fontSize: 7.5, color: '#2e4050', cursor: 'pointer',
                        fontFamily: 'inherit', letterSpacing: 1.5, transition: 'border-color .15s',
                      }}>
                      <span>RESPONSE HEADERS ({tele.headers.length})</span>
                      <span style={{ transform: hdOpen ? 'rotate(180deg)' : 'none', transition: '.2s' }}>▾</span>
                    </button>
                    {hdOpen && (
                      <div style={{
                        border: '1px solid rgba(0,232,255,.06)', borderTop: 'none',
                        borderRadius: '0 0 3px 3px', maxHeight: 160, overflowY: 'auto',
                        padding: '6px 9px',
                      }}>
                        {tele.headers.map(([k, v]) => (
                          <div key={k} style={{ marginBottom: 5 }}>
                            <div style={{ fontSize: 7, color: '#2a3a4a', letterSpacing: .4 }}>{k}</div>
                            <div style={{ fontSize: 7.5, color: '#3a5060', wordBreak: 'break-all' }}>{v.slice(0, 90)}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Network error notice (accurate messaging — not always CORS) */}
                {tele.error && (
                  <div style={{
                    padding: '7px 9px', borderRadius: 3,
                    background: 'rgba(255,180,0,.06)', border: '1px solid rgba(255,180,0,.18)',
                    fontSize: 7.5, color: '#ffb300', lineHeight: 1.65,
                  }}>
                    ⚠ {tele.status === 408
                      ? 'Target endpoint timed out (12s). The server may be slow or unreachable.'
                      : 'Target endpoint could not be reached. This may indicate a network error, DNS failure, or TLS issue.'}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Audio status bar */}
          <div style={{
            padding: '7px 14px', borderTop: '1px solid rgba(0,232,255,.06)',
            display: 'flex', alignItems: 'center', gap: 7,
            fontSize: 7.5, color: '#1a2a38', flexShrink: 0,
          }}>
            <span style={{
              color: audioOn ? '#00ffa3' : '#1a2a38',
              animation: audioOn ? 'pulse 1.8s ease-in-out infinite' : undefined,
            }}>♪</span>
            <span style={{ letterSpacing: .5 }}>
              {audioOn
                ? 'WEB AUDIO ACTIVE · FFT REACTIVE'
                : 'AUDIO INITIALIZES ON FIRST ANALYZE'}
            </span>
          </div>
        </div>
      </div>

      {/* ══ FOOTER ═══════════════════════════════════════════════ */}
      <div style={{
        padding: '5px 18px',
        borderTop: '1px solid rgba(0,232,255,.06)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        flexShrink: 0, background: 'rgba(4,5,18,.98)',
      }}>
        {/* PRD §2.2 attribution label */}
        <span style={{ fontSize: 7.5, color: '#182430', letterSpacing: .4 }}>
          Telemetry measured via Vercel Edge Network (US-East) to Target Origin
        </span>
        <span style={{ fontSize: 7.5, color: '#182430' }}>ASTONAL v1.0</span>
      </div>
    </div>
  );
}
