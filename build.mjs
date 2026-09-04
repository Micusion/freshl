// Simple zero-dependency build: src/freshl.js -> dist/freshl.esm.js + dist/freshl.umd.js
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const src = readFileSync(new URL('./src/freshl.js', import.meta.url), 'utf8');
mkdirSync(new URL('./dist', import.meta.url), { recursive: true });

// ESM dist: verbatim copy
writeFileSync(new URL('./dist/freshl.esm.js', import.meta.url), src);

// UMD dist: strip export statement, wrap in UMD factory
const exportMatch = src.match(/export\s*\{([^}]*)\}/);
if (!exportMatch) throw new Error('no named export found in src/freshl.js');
const names = exportMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
const body = src.replace(exportMatch[0], '');

const umd = `(function (root, factory) {
  if (typeof define === 'function' && define.amd) define([], factory);
  else if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Freshl = factory();
})(typeof self !== 'undefined' ? self : this, function () {
${body}
  return { ${names.join(', ')} };
});
`;

writeFileSync(new URL('./dist/freshl.umd.js', import.meta.url), umd);
// .cjs twin so `require()` works under package type:module
writeFileSync(new URL('./dist/freshl.umd.cjs', import.meta.url), umd);
console.log('built dist/freshl.esm.js, dist/freshl.umd.js, dist/freshl.umd.cjs (exports: ' + names.join(', ') + ')');
