'use strict';

// ============================================================================
// Build — Genera el artefacto en dist/ para la imagen distroless central de CCLA.
// La imagen central corre `npm run build` y arranca `dist/main.js`, copiando
// SOLO `dist/` al runtime. Este script copia src/, public/ y db/ hacia dist/.
// ============================================================================

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'src');
const publicDir = path.join(root, 'public');
const dbDir = path.join(root, 'db');
const distDir = path.join(root, 'dist');

fs.rmSync(distDir, { recursive: true, force: true });
fs.cpSync(srcDir, distDir, { recursive: true });

if (fs.existsSync(publicDir)) {
  fs.cpSync(publicDir, path.join(distDir, 'public'), { recursive: true });
}

if (fs.existsSync(dbDir)) {
  fs.cpSync(dbDir, path.join(distDir, 'db'), { recursive: true });
}

const indexJs = path.join(distDir, 'index.js');
const mainJs = path.join(distDir, 'main.js');
if (fs.existsSync(indexJs)) {
  fs.renameSync(indexJs, mainJs);
}

if (!fs.existsSync(mainJs)) {
  console.error('build: no se generó dist/main.js (se esperaba src/index.js como entry).');
  process.exit(1);
}

console.log('build: dist/main.js y recursos (public, db) generados exitosamente.');
