'use strict';
// Marca configurable por variables de entorno (BRAND_*), sin tocar el código ni reconstruir la imagen.
const fs = require('node:fs');
const { config: cfg } = require('../../config');
const { ruta } = require('./registro');

const color = (v, defecto) => (/^#[0-9a-fA-F]{3,8}$/.test(String(v || '').trim()) ? String(v).trim() : defecto);
const texto = (v) => String(v === undefined ? '' : v).slice(0, 120);

function config() {
  const m = cfg.marca;
  return { nombre: texto(m.nombre) || 'IPAM', subtitulo: texto(m.subtitulo), pie: texto(m.pie), logo: logo() ? '/brand/logo' : null };
}

function css() {
  const m = cfg.marca;
  // Valores por defecto de cada color (si el configurado no es #rrggbb).
  return (
    `:root{--top:${color(m.colorBarra, '#12203a')};--blue:${color(m.color, '#2d6cdf')};--accent:${color(m.colorAcento, '#4da3ff')}}\n` +
    `@media (prefers-color-scheme:dark){:root{--top:${color(m.colorBarra, '#0a1020')}}}\n`
  );
}

const TIPOS = [
  ['image/png', (b) => b.subarray(0, 4).toString('hex') === '89504e47'],
  ['image/jpeg', (b) => b.subarray(0, 3).toString('hex') === 'ffd8ff'],
  ['image/webp', (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP'],
  ['image/svg+xml', (b) => /<svg[\s>]/i.test(b.subarray(0, 2048).toString())],
];
let cache = { ruta: null, mtime: 0, datos: null };
function logo() {
  const archivo = cfg.marca.logoArchivo;
  if (!archivo) return null;
  try {
    const st = fs.statSync(archivo);
    if (st.size > 512 * 1024) return null;
    if (cache.ruta !== archivo || cache.mtime !== st.mtimeMs) {
      const b = fs.readFileSync(archivo);
      const t = TIPOS.find(([, ok]) => ok(b));
      cache = { ruta: archivo, mtime: st.mtimeMs, datos: t ? { tipo: t[0], buffer: b } : null };
    }
    return cache.datos;
  } catch {
    return null;
  }
}

function montar(app) {
  ruta(app, 'get', '/brand.css', (_q, res) => res.type('text/css').set('Cache-Control', 'no-cache').send(css()));
  ruta(app, 'get', '/api/config', (_q, res) => res.json(config()));
  ruta(app, 'get', '/brand/logo', (_q, res) => {
    const l = logo();
    if (!l) return res.status(404).end();
    // Un SVG abierto directamente podría ejecutar scripts: se aísla con sandbox. Dentro de <img> nunca los ejecuta.
    res.set({
      'Content-Type': l.tipo,
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(l.buffer);
  });
}

module.exports = { montar, config, css };
