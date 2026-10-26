// Marca configurable por variables de entorno (sin tocar el código ni reconstruir la imagen).
//   BRAND_NAME        nombre en la barra y el título (por defecto «IPAM»)
//   BRAND_SUBTITLE    texto pequeño junto al nombre (vacío por defecto)
//   BRAND_FOOTER      pie de página (vacío = sin pie)
//   BRAND_COLOR_TOP   color de la barra superior      (por defecto #12203a)
//   BRAND_COLOR       color principal de botones      (por defecto #2d6cdf)
//   BRAND_COLOR_ACCENT color de acento / pestaña activa (por defecto #4da3ff)
//   BRAND_LOGO_FILE   ruta de un logo (png, jpg, webp o svg) montado en el contenedor
const fs = require('fs');
const env = process.env;

const color = (v, defecto) => (/^#[0-9a-fA-F]{3,8}$/.test(String(v || '').trim()) ? v.trim() : defecto);
const texto = (v, defecto = '') => String(v === undefined ? defecto : v).slice(0, 120);

function config() {
  return {
    nombre: texto(env.BRAND_NAME, 'IPAM') || 'IPAM',
    subtitulo: texto(env.BRAND_SUBTITLE),
    pie: texto(env.BRAND_FOOTER),
    logo: logo() ? '/brand/logo' : null,
  };
}

function css() {
  return `:root{--top:${color(env.BRAND_COLOR_TOP, '#12203a')};--blue:${color(env.BRAND_COLOR, '#2d6cdf')};--accent:${color(env.BRAND_COLOR_ACCENT, '#4da3ff')}}\n`
    + `@media (prefers-color-scheme:dark){:root{--top:${color(env.BRAND_COLOR_TOP, '#0a1020')}}}\n`;
}

const TIPOS = [
  ['image/png', (b) => b.subarray(0, 4).toString('hex') === '89504e47'],
  ['image/jpeg', (b) => b.subarray(0, 3).toString('hex') === 'ffd8ff'],
  ['image/webp', (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP'],
  ['image/svg+xml', (b) => /<svg[\s>]/i.test(b.subarray(0, 2048).toString())],
];
let cache = { ruta: null, mtime: 0, datos: null };
function logo() {
  const ruta = env.BRAND_LOGO_FILE;
  if (!ruta) return null;
  try {
    const st = fs.statSync(ruta);
    if (st.size > 512 * 1024) return null;
    if (cache.ruta !== ruta || cache.mtime !== st.mtimeMs) {
      const b = fs.readFileSync(ruta);
      const t = TIPOS.find(([, ok]) => ok(b));
      cache = { ruta, mtime: st.mtimeMs, datos: t ? { tipo: t[0], buffer: b } : null };
    }
    return cache.datos;
  } catch { return null; }
}

// Favicon por defecto: cuatro bloques (el espacio de direcciones) en el color principal de la marca. Si la marca trae
// logo, las páginas usan el logo como icono y este no se pide.
function favicon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${color(env.BRAND_COLOR, '#2d6cdf')}"/>`
    + '<g fill="#fff"><rect x="6" y="6" width="9" height="9" rx="2"/><rect x="17" y="6" width="9" height="9" rx="2" opacity=".55"/>'
    + '<rect x="6" y="17" width="9" height="9" rx="2" opacity=".55"/><rect x="17" y="17" width="9" height="9" rx="2"/></g></svg>';
}

function montar(app) {
  app.get('/favicon.svg', (_q, res) => res.type('image/svg+xml').set('Cache-Control', 'no-cache').send(favicon()));
  app.get('/brand.css', (_q, res) => res.type('text/css').set('Cache-Control', 'no-cache').send(css()));
  // `demo` (DEMO=true) activa en la interfaz las ayudas para probar el sistema (p. ej. «prueba un CIDR que choque»).
  app.get('/api/config', (_q, res) => res.json({ ...config(), demo: env.DEMO === 'true' }));
  app.get('/brand/logo', (_q, res) => {
    const l = logo();
    if (!l) return res.status(404).end();
    // Un SVG abierto directamente podría ejecutar scripts: se aísla con sandbox. Dentro de <img> nunca los ejecuta.
    res.set({ 'Content-Type': l.tipo, 'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'X-Content-Type-Options': 'nosniff' });
    res.send(l.buffer);
  });
}
module.exports = { montar, config, css, favicon };
