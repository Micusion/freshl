// freshl demo server — zero dependencies (node:http only).
// Serves the test page and garbage-data APIs with artificial latency.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)); // repo root
const PORT = process.env.PORT || 8080;

// ---------------------------------------------------------------- garbage --
let seed = 42;
function rnd() {
  // deterministic xorshift so the dataset is stable across requests
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return ((seed >>> 0) % 100000) / 100000;
}
const WORDS = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore'.split(' ');
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const sentence = (n) => Array.from({ length: n }, () => pick(WORDS)).join(' ');
const cap = (s) => s[0].toUpperCase() + s.slice(1);

function user(id) {
  return {
    id,
    name: cap(pick(WORDS)) + ' ' + cap(pick(WORDS)),
    email: pick(WORDS) + id + '@example.com',
    bio: sentence(24),
    tags: Array.from({ length: 8 }, () => pick(WORDS)),
    score: rnd() * 100,
    address: { city: pick(WORDS), street: sentence(3), geo: { lat: rnd() * 90, lng: rnd() * 180 } },
    history: Array.from({ length: 30 }, (_, i) => ({ at: Date.now() - i * 86400000, action: pick(WORDS), amount: rnd() * 500 })),
  };
}

function dataset(id, depth = 4) {
  const node = (d) => ({
    label: sentence(4),
    value: rnd(),
    flag: rnd() > 0.5,
    children: d > 0 ? Array.from({ length: 4 }, () => node(d - 1)) : [],
  });
  return {
    id,
    title: sentence(6),
    description: sentence(40),
    tree: node(depth),
    rows: Array.from({ length: 200 }, (_, i) => ({
      i, a: sentence(3), b: rnd(), c: pick(WORDS), d: new Date(Date.now() - i * 1000).toISOString(),
    })),
    matrix: Array.from({ length: 50 }, () => Array.from({ length: 50 }, () => rnd())),
    users: Array.from({ length: 25 }, (_, i) => user(i + 1)),
  };
}

// ------------------------------------------------------------ fake latency --
const latency = () => 80 + Math.floor(rnd() * 120); // 80–200ms, like a real network

// -------------------------------------------------------------- mutations --
const IDS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
const VERSIONS = new Map(); // dataset id -> version counter
function bump(id) { VERSIONS.set(id, (VERSIONS.get(id) || 0) + 1); }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' });
    res.end(Buffer.isBuffer(body) ? body : typeof body === 'string' ? body : JSON.stringify(body));
  };

  // static files
  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    const map = { '/': 'demo/public/index.html', '/app.js': 'demo/public/app.js', '/freshl.js': 'dist/freshl.umd.js' };
    const file = map[url.pathname];
    if (!file) return send(404, 'not found', 'text/plain');
    try {
      return send(200, await readFile(join(ROOT, file)), MIME[extname(file)] || 'text/plain');
    } catch {
      return send(500, 'read error', 'text/plain');
    }
  }

  // APIs — human-readable routes:
  //   GET  /api/datasets                  → список доступных датасетов
  //   GET  /api/datasets/:name            → сам датасет (+ версия)
  //   POST /api/datasets/:name/update     → мутация: версия+1, новые данные
  if (url.pathname === '/api/datasets') {
    return send(200, { datasets: IDS.map((id) => ({ name: id, version: VERSIONS.get(id) || 0 })) });
  }
  const m = url.pathname.match(/^\/api\/datasets\/([a-z]+)(\/update)?$/);
  if (m) {
    const [, name, isUpdate] = m;
    if (!IDS.includes(name)) return send(404, { error: `unknown dataset «${name}», available: ${IDS.join(', ')}` });
    if (req.method === 'POST' && isUpdate) {
      bump(name);
      return send(200, { dataset: name, version: VERSIONS.get(name), mutatedAt: Date.now() });
    }
    if (req.method === 'GET' && !isUpdate) {
      const payload = { dataset: name, version: VERSIONS.get(name) || 0, generatedAt: Date.now(), data: dataset(name) };
      await new Promise((r) => setTimeout(r, latency()));
      return send(200, payload);
    }
  }
  send(404, { error: 'unknown endpoint', hint: 'GET /api/datasets, GET /api/datasets/:name, POST /api/datasets/:name/update' });
});

server.listen(PORT, () => console.log(`freshl demo → http://localhost:${PORT}`));
