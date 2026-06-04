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
   PALETTE  — Synthwave on White
   purple   #c44dff
   cobalt   #FFFFFF
   gold     #FFFFFF
   orange   #ff8c42
   bg       #0A0A0A
   surface  #FFFFFF   (barely-there purple tint)
   border   #ede8f8
   ink      #1a0a2e
   muted    #8a7a9e
═══════════════════════════════════════════════════════════════ */

function ssrfGuard(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'Malformed URL — cannot parse'; }
  if (!/^https?:$/.test(u.protocol)) return 'Only HTTP / HTTPS allowed';
  const h = u.hostname.toLowerCase();
  const deny = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '169.254.169.254', '::ffff:169.254.169.254'];
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
   AUDIO ENGINE
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
    this.liveNodes.forEach(n => { try { n.stop(0); } catch { /**/ } });
    this.liveNodes = [];
  }
  note(freq: number, type: OscillatorType, amp: number, t0: number, t1: number, dst?: AudioNode): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator(), env = ctx.createGain();
    osc.type = type; osc.frequency.value = freq;
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(amp, t0 + 0.032);
    env.gain.linearRampToValueAtTime(0, t1);
    osc.connect(env); env.connect(dst ?? this.masterGain!);
    osc.start(t0); osc.stop(t1 + 0.06); this.liveNodes.push(osc);
  }
  play2xx(seed: number = 0): void {
    this.kill(); const t = this.ctx!.currentTime;
    // Transpose the arpeggio 0–6 semitones and vary note spacing so each
    // distinct endpoint (different body length + latency) produces unique FFT peaks.
    const st = 2 ** (1 / 12);
    const rootShift = seed % 7;
    const spacing = 0.08 + (Math.floor(seed / 7) % 8) * 0.013;
    [261.63, 293.66, 329.63, 392.00, 440.00, 523.25]
      .map(f => f * (st ** rootShift))
      .forEach((f, i) => this.note(f, 'sine', 0.25, t + i * spacing, t + i * spacing + 1.4));
  }
  play3xx(seed: number = 0): void {
    this.kill(); const t = this.ctx!.currentTime;
    const st = 2 ** (1 / 12);
    const rootShift = seed % 5;
    const lyd = [261.63, 293.66, 329.63, 369.99, 392.00, 440.00, 493.88].map(f => f * (st ** rootShift));
    [0, 2, 4, 6, 1, 3, 5].forEach((idx, j) => this.note(lyd[idx], 'sine', 0.2, t + j * .16, t + j * .16 + .65));
  }
  play401(): void {
    this.kill(); const ctx = this.ctx!, t = ctx.currentTime;
    const car = ctx.createOscillator(), mod = ctx.createOscillator();
    const modGain = ctx.createGain(), outGain = ctx.createGain();
    car.type = 'square'; car.frequency.value = 110;
    mod.type = 'square'; mod.frequency.value = 440;
    modGain.gain.value = 260; mod.connect(modGain); modGain.connect(car.frequency);
    ([[0, .06], [.13, .19], [.28, .34]] as [number, number][]).forEach(([s, e]) => {
      outGain.gain.setValueAtTime(.44, t + s); outGain.gain.setValueAtTime(0, t + e);
    });
    car.connect(outGain); outGain.connect(this.masterGain!);
    car.start(t); car.stop(t + .5); mod.start(t); mod.stop(t + .5);
    this.liveNodes.push(car, mod);
  }
  play404(): void {
    this.kill(); const ctx = this.ctx!, t = ctx.currentTime;
    const delay = ctx.createDelay(3.0); delay.delayTime.value = .55;
    const fb = ctx.createGain(); fb.gain.value = .52;
    delay.connect(fb); fb.connect(delay); delay.connect(this.masterGain!);
    [146.83, 164.81, 174.61, 196.00, 220.00, 246.94].forEach((f, i) => this.note(f, 'sine', .22, t + i * .44, t + i * .44 + 1.1, delay));
  }
  play5xx(): void {
    this.kill(); const ctx = this.ctx!, t = ctx.currentTime;
    const ws = ctx.createWaveShaper(); const curve = new Float32Array(512);
    for (let i = 0; i < 512; i++) { const x = (i * 2) / 512 - 1; curve[i] = ((Math.PI + 400) * x) / (Math.PI + 400 * Math.abs(x)); }
    ws.curve = curve; ws.connect(this.masterGain!);
    [261.63, 277.18, 311.13, 329.63, 369.99, 392.00, 415.30, 440.00].forEach((f, i) => this.note(f, 'sawtooth', .28, t + i * .08, t + i * .08 + .88, ws));
  }
  playForStatus(code: number, seed: number = 0): void {
    if (!this.ctx) return;
    if (code >= 200 && code < 300) this.play2xx(seed);
    else if (code >= 300 && code < 400) this.play3xx(seed);
    else if (code === 401 || code === 403) this.play401();
    else if (code === 404 || code === 408 || code === 0) this.play404();
    else if (code >= 500) this.play5xx();
    else this.play404();
  }
  tick(): void { if (this.analyser) this.analyser.getByteFrequencyData(this.fftData); }
  get isOn(): boolean { return !!this.ctx; }
}

/* ═══════════════════════════════════════════════════════════════
   THREE.JS
═══════════════════════════════════════════════════════════════ */
const ORBIT_COLORS: number[] = [0xff6eb4, 0xc44dff, 0x5599ff, 0x4cbb17, 0xff8c42];
const depthColor = (d: number): number => ORBIT_COLORS[d % ORBIT_COLORS.length];

function getPlatonicGeo(k: number): THREE.BufferGeometry {
  const n = Math.max(k, 1);
  if (n <= 4) return new THREE.TetrahedronGeometry(.28);
  if (n <= 6) return new THREE.BoxGeometry(.38, .38, .38);
  if (n <= 8) return new THREE.OctahedronGeometry(.28);
  if (n <= 12) return new THREE.DodecahedronGeometry(.28);
  if (n <= 20) return new THREE.IcosahedronGeometry(.28);
  return new THREE.CylinderGeometry(.28, .28, .38, Math.min(n, 32), 1);
}

function makeCylinder(from: THREE.Vector3, to: THREE.Vector3, color: number, opacity: number): THREE.Object3D {
  const dir = to.clone().sub(from), len = dir.length();
  if (len < .01) return new THREE.Object3D();
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(.015, .015, len, 6),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity }),
  );
  mesh.position.copy(from.clone().add(to).multiplyScalar(.5));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return mesh;
}

function buildMeshesFromGraph(graph: OrbitalGraph, group: THREE.Group): void {
  const SIZES = [.74, .40, .24, .15] as const;
  graph.edges.forEach(({ from, to, depth }) => {
    group.add(makeCylinder(new THREE.Vector3(from.x, from.y, from.z), new THREE.Vector3(to.x, to.y, to.z), depthColor(depth), .44 - depth * .1));
  });
  graph.nodes.forEach(({ depth, keyCount, isLeaf, pos }) => {
    const color = depthColor(depth);
    const geo = depth === 0 ? new THREE.SphereGeometry(SIZES[0], 32, 32)
      : isLeaf ? getPlatonicGeo(keyCount)
        : new THREE.SphereGeometry(SIZES[Math.min(depth, 3)], 14, 14);
    const mat = new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: .38, transparent: true, opacity: depth === 0 ? 1 : .86, shininess: 70 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pos.x, pos.y, pos.z);
    mesh.userData = { baseEI: .38, depth };
    group.add(mesh);
  });
}

const PRESETS = [
  { name: 'Post', url: 'https://jsonplaceholder.typicode.com/posts/1' },
  { name: 'User', url: 'https://jsonplaceholder.typicode.com/users/1' },
  { name: 'Comments', url: 'https://jsonplaceholder.typicode.com/posts/1/comments' },
  { name: 'HTTPBin', url: 'https://httpbin.org/json' },
] as const;

type Phase = 'idle' | 'validating' | 'fetching' | 'parsing' | 'building' | 'done' | 'error';

/* ═══════════════════════════════════════════════════════════════
   MAIN COMPONENT
═══════════════════════════════════════════════════════════════ */
export default function ASTonal() {
  const mountRef = useRef<HTMLDivElement>(null);
  const rendRef = useRef<THREE.WebGLRenderer | null>(null);
  const frameRef = useRef<number>(0);
  const dataGrp = useRef<THREE.Group | null>(null);
  const idleGrp = useRef<THREE.Group | null>(null);
  const audioRef = useRef<AudioEngine>(new AudioEngine());
  const workerRef = useRef<Worker | null>(null);
  const isInit = useRef<boolean>(false);
  const running = useRef<boolean>(false);
  const dragRef = useRef<{ on: boolean; x: number; y: number }>({ on: false, x: 0, y: 0 });
  const rotRef = useRef<{ x: number; y: number }>({ x: .14, y: 0 });

  const teleRef = useRef<HTMLDivElement>(null);
  const errRef = useRef<HTMLDivElement>(null);
  const astRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const statusNumRef = useRef<HTMLDivElement>(null);
  const spectrumRef = useRef<HTMLCanvasElement>(null);
  const spectrumColorRef = useRef<{ r: number; g: number; b: number }>({ r: 85, g: 153, b: 255 });

  const [url, setUrl] = useState<string>(PRESETS[0].url);
  const [phase, setPhase] = useState<Phase>('idle');
  const [tele, setTele] = useState<TelemetryResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [astInfo, setAstInfo] = useState<ASTInfo | null>(null);
  const [hdOpen, setHdOpen] = useState<boolean>(false);
  const [audioOn, setAudioOn] = useState<boolean>(false);
  const [bgTint, setBgTint] = useState<string>('transparent');

  // GSAP
  useEffect(() => {
    if (tele && teleRef.current)
      gsap.fromTo(teleRef.current, { opacity: 0, y: 12, scale: .97 }, { opacity: 1, y: 0, scale: 1, duration: .4, ease: 'back.out(1.4)' });
  }, [tele]);

  useEffect(() => {
    if (tele && statusNumRef.current)
      gsap.fromTo(statusNumRef.current, { scale: 1.5, opacity: 0, filter: 'blur(8px)' }, { scale: 1, opacity: 1, filter: 'blur(0px)', duration: .45, ease: 'back.out(2)' });
  }, [tele]);

  useEffect(() => {
    if (err && errRef.current)
      gsap.fromTo(errRef.current, { opacity: 0, x: 8, scale: .96 }, { opacity: 1, x: 0, scale: 1, duration: .25, ease: 'back.out(1.8)' });
  }, [err]);

  useEffect(() => {
    if (astInfo && astRef.current) {
      gsap.fromTo(astRef.current, { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: .3, ease: 'power3.out' });
      gsap.fromTo(astRef.current.querySelectorAll('.stat-row'), { opacity: 0, x: -6 }, { opacity: 1, x: 0, duration: .22, stagger: .06, ease: 'power2.out', delay: .08 });
    }
  }, [astInfo]);

  useEffect(() => {
    const s = tele?.status ?? 0;
    if (s >= 200 && s < 300) spectrumColorRef.current = { r: 255, g: 215, b: 0 };
    else if (s >= 300 && s < 400) spectrumColorRef.current = { r: 85, g: 153, b: 255 };
    else if (s >= 400) spectrumColorRef.current = { r: 255, g: 110, b: 180 };
    else spectrumColorRef.current = { r: 85, g: 153, b: 255 };
  }, [tele]);

  useEffect(() => {
    if (!btnRef.current) return;
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 4 });
    tl.fromTo(btnRef.current.querySelector('.btn-shimmer') as Element, { x: '-110%' }, { x: '110%', duration: .65, ease: 'power2.inOut' });
    return () => { tl.kill(); };
  }, []);

  // Font
  useEffect(() => {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=JetBrains+Mono:ital,wght@0,400;0,700&display=swap';
    document.head.appendChild(l);
  }, []);

  // Three.js init
  useEffect(() => {
    if (isInit.current || !mountRef.current) return;
    isInit.current = true;
    const el = mountRef.current;
    const W = Math.max(el.clientWidth, 480), H = Math.max(el.clientHeight, 360);
    if (spectrumRef.current) { spectrumRef.current.width = W; spectrumRef.current.height = 96; }

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor(0x0a0a0a);
    el.appendChild(renderer.domElement);
    rendRef.current = renderer;

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0a0a0a, 18, 50);
    const cam = new THREE.PerspectiveCamera(55, W / H, .1, 100);
    cam.position.set(0, 0, 10);

    scene.add(new THREE.AmbientLight(0x111111, 0.7));
    const p1 = new THREE.PointLight(0xff6eb4, 2.2, 30); p1.position.set(6, 6, 5); scene.add(p1);
    const p2 = new THREE.PointLight(0xc44dff, 1.6, 28); p2.position.set(-5, -5, 4); scene.add(p2);
    const p3 = new THREE.PointLight(0x4cbb17, 0.9, 22); p3.position.set(0, 4, -3); scene.add(p3);
    const p4 = new THREE.PointLight(0x5599ff, 1.0, 24); p4.position.set(-3, -6, 2); scene.add(p4);

    const sp = new Float32Array(2200 * 3);
    for (let i = 0; i < sp.length; i++) sp[i] = (Math.random() - .5) * 90;
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x1a1a1a, size: .065 }));
    scene.add(stars);

    const ig = new THREE.Group();
    ig.add(new THREE.Mesh(new THREE.IcosahedronGeometry(2.4, 0), new THREE.MeshBasicMaterial({ color: 0xff6eb4, wireframe: true, transparent: true, opacity: .07 })));
    ig.add(new THREE.Mesh(new THREE.OctahedronGeometry(1.4, 0), new THREE.MeshBasicMaterial({ color: 0x5599ff, wireframe: true, transparent: true, opacity: .05 })));
    const innerMesh = new THREE.Mesh(new THREE.OctahedronGeometry(.4), new THREE.MeshPhongMaterial({ color: 0xff6eb4, emissive: 0xff6eb4, emissiveIntensity: 1.2 }));
    ig.add(innerMesh);
    const ring1 = new THREE.Mesh(new THREE.TorusGeometry(1.45, .015, 6, 80), new THREE.MeshBasicMaterial({ color: 0x5599ff, transparent: true, opacity: .32 }));
    ring1.rotation.x = Math.PI / 4; ig.add(ring1);
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(2.0, .012, 6, 80), new THREE.MeshBasicMaterial({ color: 0x4cbb17, transparent: true, opacity: .2 }));
    ring2.rotation.x = -Math.PI / 3; ring2.rotation.y = Math.PI / 5; ig.add(ring2);
    const ring3 = new THREE.Mesh(new THREE.TorusGeometry(1.1, .01, 6, 60), new THREE.MeshBasicMaterial({ color: 0xff6eb4, transparent: true, opacity: .2 }));
    ring3.rotation.z = Math.PI / 6; ig.add(ring3);
    scene.add(ig); idleGrp.current = ig;

    const dg = new THREE.Group(); scene.add(dg); dataGrp.current = dg;

    let t = 0;
    function loop() {
      frameRef.current = requestAnimationFrame(loop); t += .016;
      if (ig.visible) {
        ig.rotation.y = t * .22; ig.rotation.x = Math.sin(t * .14) * .28;
        innerMesh.scale.setScalar(1 + Math.sin(t * 1.7) * .28);
        ring3.rotation.z = t * .35;
      }
      if (dg.children.length > 0) {
        dg.rotation.y += (rotRef.current.y - dg.rotation.y) * .08;
        dg.rotation.x += (rotRef.current.x - dg.rotation.x) * .08;
        if (!dragRef.current.on) rotRef.current.y += .003;
      }
      audioRef.current.tick();
      const fft = audioRef.current.fftData;
      if (fft.length && dg.children.length) {
        const lo = (fft[1] + fft[2] + fft[3]) / (3 * 255), mi = (fft[12] + fft[15] + fft[18]) / (3 * 255), hi = (fft[35] + fft[42] + fft[50]) / (3 * 255);
        dg.children.forEach(obj => {
          if (!(obj instanceof THREE.Mesh)) return;
          const d = (obj.userData as { depth: number }).depth ?? 0;
          const pulse = d === 0 ? lo : d === 1 ? mi : hi;
          (obj.material as THREE.MeshPhongMaterial).emissiveIntensity = .38 + pulse * 1.4;
          if (d <= 1) obj.scale.setScalar(1 + pulse * .18);
        });
      }
      stars.rotation.y = t * .0045; stars.rotation.x = t * .0015;
      renderer.render(scene, cam);

      // ── FFT spectrum overlay ─────────────────────────────────
      const sc2 = spectrumRef.current;
      if (sc2) {
        const ctx2d = sc2.getContext('2d');
        if (ctx2d) {
          const SW = sc2.width, SH = sc2.height;
          ctx2d.clearRect(0, 0, SW, SH);
          const fftArr = audioRef.current.fftData;
          const BINS = 64;
          const step = Math.max(1, Math.floor(fftArr.length / BINS));
          const barW = SW / BINS;
          const { r, g, b } = spectrumColorRef.current;
          ctx2d.shadowColor = `rgba(${r},${g},${b},0.55)`;
          ctx2d.shadowBlur = 6;
          for (let i = 0; i < BINS; i++) {
            const val = fftArr[i * step] / 255;
            const barH = val * SH;
            if (barH < 1) continue;
            const grd = ctx2d.createLinearGradient(0, SH - barH, 0, SH);
            grd.addColorStop(0, `rgba(${r},${g},${b},0.88)`);
            grd.addColorStop(0.6, `rgba(${r},${g},${b},0.35)`);
            grd.addColorStop(1, `rgba(${r},${g},${b},0.05)`);
            ctx2d.fillStyle = grd;
            ctx2d.fillRect(i * barW + 1, SH - barH, barW - 2, barH);
          }
          ctx2d.shadowBlur = 0;
        }
      }
    }
    loop();

    const onResize = () => {
      if (!el) return;
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix();
      if (spectrumRef.current) spectrumRef.current.width = w;
    };
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(frameRef.current);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      try { el.removeChild(renderer.domElement); } catch { /**/ }
      isInit.current = false;
    };
  }, []);

  // Worker
  useEffect(() => {
    workerRef.current = new Worker(new URL('./workers/ast.worker.ts', import.meta.url), { type: 'module' });
    return () => { workerRef.current?.terminate(); workerRef.current = null; };
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => { dragRef.current = { on: true, x: e.clientX, y: e.clientY }; }, []);
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragRef.current.on) return;
    rotRef.current.y += (e.clientX - dragRef.current.x) * .010;
    rotRef.current.x += (e.clientY - dragRef.current.y) * .010;
    dragRef.current.x = e.clientX; dragRef.current.y = e.clientY;
  }, []);
  const onMouseUp = useCallback(() => { dragRef.current.on = false; }, []);

  const analyze = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setErr(null); setTele(null); setAstInfo(null); setHdOpen(false);
    try {
      setPhase('validating');
      const guardErr = ssrfGuard(url);
      if (guardErr) { setErr(guardErr); setPhase('error'); return; }

      if (!audioRef.current.isOn) { audioRef.current.init(); setAudioOn(true); }

      if (idleGrp.current) idleGrp.current.visible = false;
      const dg = dataGrp.current!;
      dg.children.forEach(obj => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose()); else obj.material.dispose();
        }
      });
      while (dg.children.length) dg.remove(dg.children[0]);

      setPhase('fetching');
      let res: TelemetryResult;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 14_000);
      try {
        const proxyResp = await fetch('/api/telemetry', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }), signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (proxyResp.status === 429 || proxyResp.status === 400) {
          const { error } = (await proxyResp.json()) as { error: string };
          setErr(error); setPhase('error'); return;
        }
        const payload = (await proxyResp.json()) as Omit<TelemetryResult, 'url'>;
        res = { ...payload, url };
      } catch (ex) {
        clearTimeout(timer);
        res = {
          url, status: (ex as Error).name === 'AbortError' ? 408 : 0,
          statusText: (ex as Error).name === 'AbortError' ? 'Request Timeout' : 'Network Error',
          timing: { ttfb: 0, total: 0 }, headers: [], redirected: false, redirectLocation: null,
          body: '', contentType: '', error: ex instanceof Error ? ex.message : 'Unknown error',
        };
      }

      setTele(res);
      // Seed from body size XOR'd with rounded ttfb — gives distinct values per
      // endpoint regardless of rounding, and drifts slightly each re-request.
      const audioSeed = (res.body.length ^ Math.round(res.timing.ttfb * 3.7)) & 0xFF;
      audioRef.current.playForStatus(res.status, audioSeed);

      if (res.status >= 200 && res.status < 300) setBgTint('rgba(255,215,0,.06)');
      else if (res.status >= 300 && res.status < 400) setBgTint('rgba(85,153,255,.06)');
      else if (res.status >= 400 && res.status < 500) setBgTint('rgba(255,110,180,.07)');
      else if (res.status >= 500) setBgTint('rgba(255,140,66,.07)');
      else setBgTint('transparent');

      const rawBody = res.body.trim();
      if ((rawBody.startsWith('{') || rawBody.startsWith('[')) && workerRef.current) {
        setPhase('parsing');
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
        if (graph) {
          setPhase('building');
          setAstInfo({ nodes: graph.totalNodes, depth: graph.maxDepth, type: graph.rootType });
          buildMeshesFromGraph(graph, dg);
        }
      }
      setPhase('done');
    } finally { running.current = false; }
  }, [url]);

  // ── palette ─────────────────────────────────────────────────
  // sakura #ff6eb4  → CTA, errors, 4xx, interactive
  // cobalt #5599ff  → labels, info, 3xx, fast timing
  // gold   #4cbb17  → success, 2xx, AST data, highlights
  const statusColor = (s: number): string => {
    if (s >= 200 && s < 300) return '#4cbb17';  // gold  — success
    if (s >= 300 && s < 400) return '#5599ff';  // cobalt — redirect
    if (s >= 400) return '#ff6eb4';             // sakura — error
    return '#555';
  };

  const busy = (['fetching', 'parsing', 'building'] as Phase[]).includes(phase);
  const sc = tele ? statusColor(tele.status) : null;

  const PHASE_COLOR: Record<Phase, string> = {
    idle: '#2e2e2e', validating: '#5599ff', fetching: '#5599ff',
    parsing: '#4cbb17', building: '#ff6eb4', done: '#4cbb17', error: '#ff6eb4',
  };

  /* ─────────────────────────────────────────────────────────────
     RENDER
  ───────────────────────────────────────────────────────────── */
  return (
    <div style={{
      width: '100vw', height: '100vh', background: '#0A0A0A',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      fontFamily: "-apple-system,BlinkMacSystemFont,'SF Pro Display','SF Pro Text','Helvetica Neue',system-ui,sans-serif",
      color: '#e8e8e8',
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=JetBrains+Mono:ital,wght@0,400;0,700&display=swap');
        *{box-sizing:border-box;}
        ::-webkit-scrollbar{width:3px;}
        ::-webkit-scrollbar-thumb{background:#1e1e1e;border-radius:3px;}
        ::-webkit-scrollbar-thumb:hover{background:#2a2a2a;}

        @keyframes spin         { to { transform: rotate(360deg) } }
        @keyframes pulse        { 0%,100%{opacity:1} 50%{opacity:.18} }
        @keyframes shimmer-move { 0%,100%{transform:translateX(-110%)} 50%{transform:translateX(110%)} }
        @keyframes logo-breathe { 0%,100%{filter:drop-shadow(0 0 3px #ff6eb4)} 50%{filter:drop-shadow(0 0 9px #ff6eb4)} }
        @keyframes float        { 0%,100%{transform:translateX(-50%) translateY(0)} 50%{transform:translateX(-50%) translateY(-5px)} }

        .url-input { transition: border-color .15s, box-shadow .15s; }
        .url-input:focus {
          border-color: #5599ff !important;
          outline: none;
          box-shadow: 0 0 0 2px rgba(85,153,255,.12) !important;
        }

        .preset-chip { transition: border-color .12s, color .12s, background .12s; cursor: pointer; }
        .preset-chip:hover  { border-color: #5599ff !important; color: #5599ff !important; }
        .preset-chip.active { border-color: #5599ff !important; color: #5599ff !important; background: rgba(85,153,255,.07) !important; }

        .analyze-btn { position: relative; overflow: hidden; transition: opacity .15s, transform .15s; }
        .analyze-btn:not(:disabled):hover  { opacity: .86; transform: translateY(-1px); }
        .analyze-btn:not(:disabled):active { transform: translateY(0); opacity: 1; }
        .btn-shimmer {
          position: absolute; inset: 0;
          background: linear-gradient(105deg, transparent 35%, rgba(255,255,255,.22) 50%, transparent 65%);
          pointer-events: none;
        }

        .hdr-toggle { transition: border-color .12s, color .12s; }
        .hdr-toggle:hover { border-color: #5599ff !important; color: #5599ff !important; }

        .stat-row { border-radius: 3px; transition: background .1s; }
        .stat-row:hover { background: #111; }

        .canvas-wrap { cursor: crosshair; }
        .canvas-wrap:active { cursor: grabbing; }

        .section-label {
          display: flex; align-items: center; gap: 6px;
          font-size: 7.5px; letter-spacing: 2.5px; font-weight: 700; text-transform: uppercase;
        }
        .section-label::before {
          content: ''; display: inline-block;
          width: 2px; height: 9px; border-radius: 2px; flex-shrink: 0;
        }
        .label-cobalt { color: #5599ff; }
        .label-cobalt::before { background: #5599ff; }
        .label-gold   { color: #4cbb17; }
        .label-gold::before   { background: #4cbb17; }
      `}</style>

      {/* HEADER */}
      <header style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '0 20px',
        height: 52, flexShrink: 0,
        borderBottom: '1px solid #141414',
        background: '#0A0A0A',
      }}>
        <div style={{ animation: 'logo-breathe 3s ease-in-out infinite', color: '#ff6eb4', fontSize: 17, lineHeight: 1, flexShrink: 0 }}>◈</div>

        <div style={{
          fontFamily: "'Orbitron',sans-serif",
          fontSize: 12, fontWeight: 900, letterSpacing: 4,
          background: 'linear-gradient(90deg, #ff6eb4 0%, #4cbb17 100%)',
          WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
          flexShrink: 0,
        }}>ASTONAL</div>

        <div style={{ width: 1, height: 14, background: '#1e1e1e', flexShrink: 0 }} />

        <div style={{ fontSize: 9, color: '#2a2a2a', letterSpacing: .8, fontFamily: "'JetBrains Mono',monospace" }}>
          api · ast · audio
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            width: 5, height: 5, borderRadius: '50%', display: 'inline-block', flexShrink: 0,
            background: PHASE_COLOR[phase],
            boxShadow: `0 0 8px ${PHASE_COLOR[phase]}`,
            animation: busy ? 'pulse .7s ease-in-out infinite' : undefined,
          }} />
          <span style={{
            fontSize: 9, fontWeight: 700, letterSpacing: 1.5,
            color: PHASE_COLOR[phase],
            fontFamily: "'Orbitron',sans-serif",
          }}>{phase}</span>
        </div>

        <div style={{ fontSize: 8, color: '#1a1a1a', letterSpacing: 1, marginLeft: 10, fontFamily: "'JetBrains Mono',monospace" }}>us-east</div>
      </header>

      {/* MAIN */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>

        {/* CANVAS */}
        <div
          ref={mountRef}
          className="canvas-wrap"
          onMouseDown={onMouseDown} onMouseMove={onMouseMove}
          onMouseUp={onMouseUp} onMouseLeave={onMouseUp}
          style={{ flex: '1 1 62%', position: 'relative', overflow: 'hidden', borderRight: '1px solid #141414', minHeight: 300 }}
        >
          <div style={{ position: 'absolute', inset: 0, background: bgTint, pointerEvents: 'none', zIndex: 1, transition: 'background 1.4s ease' }} />

          {/* Corner brackets — sakura TL, cobalt TR, gold BL+BR */}
          {([
            { top: 10, left: 10,   borderTop: '1.5px solid #ff6eb4', borderLeft: '1.5px solid #ff6eb4' },
            { top: 10, right: 10,  borderTop: '1.5px solid #5599ff', borderRight: '1.5px solid #5599ff' },
            { bottom: 10, left: 10,  borderBottom: '1.5px solid #4cbb17', borderLeft: '1.5px solid #4cbb17' },
            { bottom: 10, right: 10, borderBottom: '1.5px solid #4cbb17', borderRight: '1.5px solid #4cbb17' },
          ] as React.CSSProperties[]).map((s, i) => (
            <div key={i} style={{ position: 'absolute', width: 16, height: 16, pointerEvents: 'none', zIndex: 3, ...s }} />
          ))}

          {/* FFT spectrum canvas overlay */}
          <canvas
            ref={spectrumRef}
            style={{
              position: 'absolute', bottom: 0, left: 0,
              width: '100%', height: 96,
              pointerEvents: 'none', zIndex: 2,
              opacity: audioOn ? 0.92 : 0.18,
              transition: 'opacity 1.2s ease',
            }}
            width={800}
            height={96}
          />

          {phase === 'idle' && (
            <div style={{
              position: 'absolute', bottom: 22, left: '50%',
              zIndex: 4, pointerEvents: 'none', whiteSpace: 'nowrap',
              animation: 'float 2.8s ease-in-out infinite',
              fontSize: 8, letterSpacing: 4, color: '#ff6eb4',
              fontFamily: "'Orbitron',sans-serif", opacity: .65,
            }}>◦ awaiting endpoint ◦</div>
          )}

          {phase === 'done' && (
            <div style={{
              position: 'absolute', bottom: 14, left: 14, zIndex: 4, pointerEvents: 'none',
              fontSize: 8, color: '#2a2a2a', letterSpacing: 2,
              fontFamily: "'JetBrains Mono',monospace",
            }}>drag to rotate</div>
          )}

          {busy && (
            <div style={{
              position: 'absolute', inset: 0, zIndex: 5, pointerEvents: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(10,10,10,.72)', backdropFilter: 'blur(3px)',
            }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ position: 'relative', width: 42, height: 42, margin: '0 auto 14px' }}>
                  <div style={{ position: 'absolute', inset: 0,  border: '1.5px solid #141414', borderTop: '1.5px solid #ff6eb4', borderRadius: '50%', animation: 'spin .6s linear infinite' }} />
                  <div style={{ position: 'absolute', inset: 7,  border: '1.5px solid #141414', borderTop: '1.5px solid #5599ff', borderRadius: '50%', animation: 'spin .95s linear infinite reverse' }} />
                  <div style={{ position: 'absolute', inset: 14, border: '1px solid #141414',   borderTop: '1px solid #4cbb17',  borderRadius: '50%', animation: 'spin 1.45s linear infinite' }} />
                </div>
                <div style={{ fontFamily: "'Orbitron',sans-serif", fontSize: 7, letterSpacing: 3, color: PHASE_COLOR[phase] }}>{phase}</div>
              </div>
            </div>
          )}
        </div>

        {/* RIGHT PANEL */}
        <div style={{
          width: 288, flexShrink: 0, display: 'flex', flexDirection: 'column',
          background: '#0A0A0A', overflow: 'hidden',
        }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: '18px 16px 14px' }}>

            {/* URL input */}
            <div style={{ marginBottom: 16 }}>
              <div className="section-label label-cobalt" style={{ marginBottom: 7 }}>Target Endpoint</div>
              <input
                className="url-input"
                value={url}
                onChange={e => setUrl(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && void analyze()}
                placeholder="https://api.example.com/data"
                style={{
                  width: '100%', background: '#0d0d0d', border: '1px solid #1e1e1e',
                  borderRadius: 5, padding: '8px 10px',
                  fontSize: 10.5, color: '#e8e8e8',
                  fontFamily: "'JetBrains Mono','Courier New',monospace",
                  outline: 'none',
                }}
              />
            </div>

            {/* Presets */}
            <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid #141414' }}>
              <div className="section-label label-cobalt" style={{ marginBottom: 8 }}>Presets</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {PRESETS.map(p => (
                  <button key={p.url} onClick={() => setUrl(p.url)}
                    className={`preset-chip${url === p.url ? ' active' : ''}`}
                    style={{
                      background: url === p.url ? 'rgba(85,153,255,.07)' : 'transparent',
                      border: `1px solid ${url === p.url ? '#5599ff' : '#1e1e1e'}`,
                      color: url === p.url ? '#5599ff' : '#444',
                      fontSize: 10, padding: '4px 10px', borderRadius: 4,
                      fontFamily: 'inherit',
                    }}>
                    {p.name}
                  </button>
                ))}
              </div>
            </div>

            {/* Analyze button */}
            <button
              ref={btnRef}
              onClick={() => void analyze()}
              disabled={busy}
              className="analyze-btn"
              style={{
                width: '100%', padding: '11px 16px',
                background: busy ? '#111' : '#ff6eb4',
                border: 'none', borderRadius: 6,
                color: busy ? '#333' : '#0A0A0A',
                fontFamily: "'Orbitron',sans-serif",
                fontSize: 8.5, letterSpacing: 2.5, fontWeight: 900,
                cursor: busy ? 'not-allowed' : 'pointer',
                marginBottom: 18,
              }}>
              <span className="btn-shimmer" />
              {busy ? `${phase}...` : 'connect & analyze'}
            </button>

            {/* Error */}
            {err && (
              <div ref={errRef} style={{
                padding: '9px 11px', borderRadius: 5, marginBottom: 16,
                border: '1px solid rgba(255,110,180,.28)', borderLeft: '2px solid #ff6eb4',
                background: 'rgba(255,110,180,.04)',
                fontSize: 10.5, color: '#ff6eb4', lineHeight: 1.6,
              }}>✕ {err}</div>
            )}

            {/* Telemetry */}
            {tele && (
              <div ref={teleRef}>

                {/* Status hero */}
                <div style={{
                  marginBottom: 16, paddingBottom: 14,
                  borderBottom: '1px solid #141414',
                  borderTop: `2px solid ${sc!}`,
                  paddingTop: 12,
                  background: `linear-gradient(180deg, ${sc!}09 0%, transparent 55%)`,
                  marginLeft: -16, marginRight: -16, paddingLeft: 16, paddingRight: 16,
                }}>
                  <div ref={statusNumRef} style={{
                    fontFamily: "'Orbitron',sans-serif",
                    fontSize: 56, fontWeight: 900, lineHeight: 1,
                    color: sc!, letterSpacing: 1,
                    fontVariantNumeric: 'tabular-nums',
                  }}>{tele.status || 'ERR'}</div>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 5, fontWeight: 500 }}>{tele.statusText}</div>
                  <div style={{ fontSize: 8.5, color: '#2e2e2e', marginTop: 3, fontFamily: "'JetBrains Mono',monospace" }}>
                    {tele.redirected ? '↪ redirected' : '↳ direct response'}
                  </div>
                </div>

                {/* Timing */}
                <div style={{ marginBottom: 16, paddingBottom: 14, borderBottom: '1px solid #141414' }}>
                  <div className="section-label label-cobalt" style={{ marginBottom: 10 }}>Timing</div>
                  {([['TTFB', tele.timing.ttfb], ['Total', tele.timing.total]] as [string, number][]).map(([label, val]) => {
                    const barColor = val > 1200 ? '#ff6eb4' : val > 500 ? '#4cbb17' : '#5599ff';
                    return (
                      <div key={label} style={{ marginBottom: 9 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
                          <span style={{ fontSize: 9, color: '#3e3e3e', letterSpacing: .5 }}>{label}</span>
                          <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", fontWeight: 700, color: barColor, fontVariantNumeric: 'tabular-nums' }}>
                            {val}<span style={{ fontSize: 8.5, fontWeight: 400, color: '#2e2e2e', marginLeft: 2 }}>ms</span>
                          </span>
                        </div>
                        <div style={{ height: 3, background: '#141414', borderRadius: 2, overflow: 'hidden' }}>
                          <div style={{ height: '100%', borderRadius: 2, width: `${Math.min(val / 2000, 1) * 100}%`, background: barColor, transition: 'width .9s cubic-bezier(.34,1.2,.64,1)' }} />
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* AST geometry */}
                {astInfo && (
                  <div ref={astRef} style={{ marginBottom: 16, paddingBottom: 14, borderBottom: '1px solid #141414' }}>
                    <div className="section-label label-gold" style={{ marginBottom: 10 }}>AST Geometry</div>
                    {([
                      ['Root type', astInfo.type],
                      ['Total nodes', String(astInfo.nodes)],
                      ['Max depth', String(astInfo.depth)],
                    ] as [string, string][]).map(([l, v]) => (
                      <div key={l} className="stat-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 6px', marginBottom: 1 }}>
                        <span style={{ fontSize: 9.5, color: '#3e3e3e' }}>{l}</span>
                        <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono',monospace", fontWeight: 700, color: '#4cbb17' }}>{v}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Content-type token */}
                {tele.contentType && (
                  <div style={{ marginBottom: 14, padding: '5px 8px', borderRadius: 4, background: '#0d0d0d', border: '1px solid #141414', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ fontSize: 7.5, color: '#2e2e2e', letterSpacing: 1, textTransform: 'uppercase' }}>type</span>
                    <span style={{ fontSize: 9.5, fontFamily: "'JetBrains Mono',monospace", color: '#555' }}>{tele.contentType.split(';')[0]}</span>
                  </div>
                )}

                {/* Headers */}
                {tele.headers.length > 0 && (
                  <div style={{ marginBottom: 14 }}>
                    <button onClick={() => setHdOpen(o => !o)} className="hdr-toggle"
                      style={{
                        width: '100%', background: 'transparent',
                        border: '1px solid #1a1a1a', borderRadius: 4,
                        padding: '7px 10px',
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        fontSize: 9.5, color: '#3e3e3e', cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}>
                      <span>response headers <span style={{ color: '#5599ff' }}>({tele.headers.length})</span></span>
                      <span style={{ transform: hdOpen ? 'rotate(180deg)' : 'none', transition: '.22s', color: '#5599ff', fontSize: 11 }}>▾</span>
                    </button>
                    {hdOpen && (
                      <div style={{ border: '1px solid #141414', borderTop: 'none', borderRadius: '0 0 4px 4px', maxHeight: 150, overflowY: 'auto', padding: '8px 10px', background: '#0d0d0d' }}>
                        {tele.headers.map(([k, v]) => (
                          <div key={k} style={{ marginBottom: 7 }}>
                            <div style={{ fontSize: 8.5, color: '#2a2a2a' }}>{k}</div>
                            <div style={{ fontSize: 9.5, color: '#4a4a4a', wordBreak: 'break-all', fontFamily: "'JetBrains Mono',monospace" }}>{v.slice(0, 90)}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Network error note */}
                {tele.error && (
                  <div style={{
                    padding: '9px 11px', borderRadius: 5,
                    border: '1px solid rgba(255,215,0,.22)', borderLeft: '2px solid #4cbb17',
                    background: 'rgba(255,215,0,.03)',
                    fontSize: 10, color: '#4cbb17', lineHeight: 1.65,
                  }}>
                    ⚠ {tele.status === 408
                      ? 'Timed out after 14s. Server may be slow or unreachable.'
                      : 'Could not reach endpoint. Check network, DNS, or TLS.'}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Audio footer */}
          <div style={{ padding: '8px 16px', borderTop: '1px solid #141414', display: 'flex', alignItems: 'center', gap: 9, flexShrink: 0 }}>
            {audioOn ? (
              <>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 13, flexShrink: 0 }}>
                  {[1, .55, .85, .45, .7].map((h, i) => (
                    <span key={i} style={{
                      display: 'inline-block', width: 2, borderRadius: 1,
                      height: `${h * 13}px`,
                      background: i % 2 === 0 ? '#ff6eb4' : '#4cbb17',
                      animation: `pulse ${.55 + i * .13}s ease-in-out infinite`,
                      animationDelay: `${i * .09}s`,
                    }} />
                  ))}
                </div>
                <span style={{ fontSize: 9, color: '#5599ff', letterSpacing: .3 }}>audio active · fft reactive</span>
              </>
            ) : (
              <span style={{ fontSize: 9, color: '#1e1e1e' }}>audio initializes on first analyze</span>
            )}
          </div>
        </div>
      </div>

      {/* FOOTER */}
      <footer style={{
        padding: '5px 20px', borderTop: '1px solid #141414',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        flexShrink: 0, background: '#0A0A0A',
      }}>
        <span style={{ fontSize: 8.5, color: '#1e1e1e' }}>Telemetry via Vercel Edge Network (US-East)</span>
        <span style={{ fontSize: 8, color: '#4cbb17', fontWeight: 700, letterSpacing: 1.5, fontFamily: "'Orbitron',sans-serif" }}>ASTONAL v1.0</span>
      </footer>
    </div>
  );
}
