/// <reference lib="webworker" />
// All imports are type-only — erased at runtime, safe in worker scope
import type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
  ASTNodeType,
  OrbitalNode,
  OrbitalEdge,
  Vec3,
} from '../types/worker-contracts';

/* ─── Internal AST representation ─────────────────────────────────────────── */

interface InternalNode {
  id: string;
  key: string;
  type: ASTNodeType;
  depth: number;
  keyCount: number;
  children: InternalNode[];
}

let _id = 0;
const uid = (): string => 'n' + (++_id);

function toAST(val: unknown, key: string, depth: number): InternalNode {
  if (val === null)
    return { id: uid(), key, type: 'null', depth, keyCount: 0, children: [] };

  if (Array.isArray(val)) {
    const children = val.slice(0, 12).map((v, i) => toAST(v, `[${i}]`, depth + 1));
    // keyCount is capped to the sliced child count — the full length is irrelevant for
    // geometry selection and passing it raw (e.g. 400 for HP API) can produce degenerate
    // platonic solids when the node is treated as a leaf.
    return { id: uid(), key, type: 'array', depth, keyCount: children.length, children };
  }

  if (typeof val === 'object') {
    const keys = Object.keys(val as Record<string, unknown>).slice(0, 14);
    const children = keys.map(k =>
      toAST((val as Record<string, unknown>)[k], k, depth + 1)
    );
    return { id: uid(), key, type: 'object', depth, keyCount: keys.length, children };
  }

  return { id: uid(), key, type: 'primitive', depth, keyCount: 0, children: [] };
}

/* ─── Orbital layout (pure math — mirrors buildOrbitalGraph from PRD §3.2) ── */
// Three.js is NOT importable in worker scope (uses DOM/WebGL APIs).
// All position arithmetic is plain number math; main thread converts to THREE.Vector3.

const RADII = [0, 4.2, 2.5, 1.6] as const;

function computeLayout(
  node: InternalNode,
  pos: Vec3,
  depth: number,
  baseAngle: number,
  nodes: OrbitalNode[],
  edges: OrbitalEdge[],
): void {
  nodes.push({
    id: node.id,
    key: node.key,
    nodeType: node.type,
    depth,
    keyCount: node.keyCount,
    isLeaf: node.children.length === 0,
    pos: { ...pos },
  });

  if (node.children.length === 0 || depth >= 2) return;

  const count = node.children.length;
  const step = (Math.PI * 2) / Math.max(count, 1);
  const tilt = 0.42 * depth;
  const r = RADII[Math.min(depth + 1, 3)];

  for (let i = 0; i < count; i++) {
    const angle = baseAngle + i * step;
    const childPos: Vec3 = {
      x: pos.x + r * Math.cos(angle),
      y: pos.y + r * Math.sin(tilt) * Math.sin(angle + depth * 0.5),
      z: pos.z + r * Math.cos(tilt) * Math.sin(angle),
    };
    edges.push({ from: { ...pos }, to: { ...childPos }, depth });
    computeLayout(node.children[i], childPos, depth + 1, angle + 0.55, nodes, edges);
  }
}

/* ─── Message handler ──────────────────────────────────────────────────────── */

self.onmessage = (e: MessageEvent<WorkerInboundMessage>): void => {
  const { type, payload, rid } = e.data;
  if (type !== 'PARSE_JSON') return;

  try {
    _id = 0;
    const ast = toAST(JSON.parse(payload) as unknown, 'root', 0);

    // Accumulate stats in a single pass
    let totalNodes = 0;
    let maxDepth = 0;
    const walk = (n: InternalNode): void => {
      totalNodes++;
      if (n.depth > maxDepth) maxDepth = n.depth;
      n.children.forEach(walk);
    };
    walk(ast);

    // Compute orbital positions (moves all coordinate math off the main thread)
    const nodes: OrbitalNode[] = [];
    const edges: OrbitalEdge[] = [];
    computeLayout(ast, { x: 0, y: 0, z: 0 }, 0, 0, nodes, edges);

    const msg: WorkerOutboundMessage = {
      type: 'AST_RESULT',
      rid,
      graph: { nodes, edges, rootType: ast.type, totalNodes, maxDepth },
    };
    self.postMessage(msg);
  } catch (err) {
    const msg: WorkerOutboundMessage = {
      type: 'AST_ERROR',
      rid,
      msg: err instanceof Error ? err.message : 'Unknown worker error',
    };
    self.postMessage(msg);
  }
};
