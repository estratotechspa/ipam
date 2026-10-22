const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const claves = ['BRAND_NAME', 'BRAND_SUBTITLE', 'BRAND_FOOTER', 'BRAND_COLOR_TOP', 'BRAND_COLOR', 'BRAND_COLOR_ACCENT', 'BRAND_LOGO_FILE'];
const limpiar = () => claves.forEach((k) => delete process.env[k]);
const marca = require('./marca');

test('valores por defecto: IPAM, sin subtítulo ni logo', () => {
  limpiar();
  assert.deepEqual(marca.config(), { nombre: 'IPAM', subtitulo: '', pie: '', logo: null });
  assert.match(marca.css(), /--top:#12203a;--blue:#2d6cdf;--accent:#4da3ff/);
});

test('nombre, subtítulo, pie y colores configurables', () => {
  limpiar();
  Object.assign(process.env, {
    BRAND_NAME: 'NetOps',
    BRAND_SUBTITLE: 'Cliente S.A.',
    BRAND_FOOTER: 'Uso interno',
    BRAND_COLOR: '#0a7d4f',
    BRAND_COLOR_TOP: '#111',
  });
  assert.deepEqual(marca.config(), { nombre: 'NetOps', subtitulo: 'Cliente S.A.', pie: 'Uso interno', logo: null });
  assert.match(marca.css(), /--top:#111;--blue:#0a7d4f/);
});

test('un color con código malicioso se descarta (sin inyección de CSS)', () => {
  limpiar();
  process.env.BRAND_COLOR = 'red;}body{display:none';
  assert.match(marca.css(), /--blue:#2d6cdf/);
  assert.ok(!marca.css().includes('display:none'));
});

test('logo: solo se acepta una imagen real (png, jpg, webp, svg)', () => {
  limpiar();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marca-'));
  const png = path.join(dir, 'logo.png');
  fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a0000', 'hex'));
  process.env.BRAND_LOGO_FILE = png;
  assert.equal(marca.config().logo, '/brand/logo');
  const falso = path.join(dir, 'x.png');
  fs.writeFileSync(falso, '#!/bin/sh\necho hola');
  process.env.BRAND_LOGO_FILE = falso;
  assert.equal(marca.config().logo, null);
  process.env.BRAND_LOGO_FILE = path.join(dir, 'no-existe.png');
  assert.equal(marca.config().logo, null);
  limpiar();
});
