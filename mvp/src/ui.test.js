// Comprobaciones estáticas de la interfaz (no necesitan base de datos): tokens de diseño, contraste WCAG medido sobre
// el CSS real, set de iconos y estructura accesible de index.html. El comportamiento en el navegador se prueba en e2e/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLICO = path.join(__dirname, '..', 'public');
const leer = (f) => fs.readFileSync(path.join(PUBLICO, f), 'utf8');
const css = leer('app.css');

// ---- tokens: se leen del bloque :root claro y del bloque oscuro (prefers-color-scheme) ----
const declaraciones = (bloque) => Object.fromEntries([...bloque.matchAll(/(--[\w-]+):([^;}]+)/g)].map((m) => [m[1], m[2].trim()]));
const claro = declaraciones(css.match(/:root\{([^}]*)\}/)[1]);
const oscuro = { ...claro, ...declaraciones(css.match(/prefers-color-scheme:dark\)\{:root\{([^}]*)\}\}/)[1]) };
const valor = (t, n) => {
  let v = t[n];
  for (let i = 0; i < 5 && /^var\((--[\w-]+)\)$/.test(v); i++) v = t[v.match(/var\((--[\w-]+)\)/)[1]];
  return v;
};

// ---- contraste WCAG 2.x ----
const rgb = (h) => {
  const x = h.replace('#', '');
  const c = x.length === 3 ? [...x].map((d) => d + d) : x.match(/../g);
  return c.map((v) => parseInt(v, 16));
};
const luz = (hex) => {
  const [r, g, b] = rgb(hex).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [luz(a), luz(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const mezcla = (a, b, pa) =>
  '#' +
  rgb(a)
    .map((v, i) =>
      Math.round(v * pa + rgb(b)[i] * (1 - pa))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');

test('tokens: escala tipográfica 12/14/16/20/28, espaciado 4/8/12/16/24 y radios', () => {
  assert.deepEqual(
    ['--fs-xs', '--fs-sm', '--fs-md', '--fs-lg', '--fs-xl'].map((n) => claro[n]),
    ['12px', '14px', '16px', '20px', '28px'],
  );
  assert.deepEqual(
    ['--sp-1', '--sp-2', '--sp-3', '--sp-4', '--sp-5'].map((n) => claro[n]),
    ['4px', '8px', '12px', '16px', '24px'],
  );
  for (const r of ['--r-sm', '--r-md', '--r-lg', '--r-pill']) assert.ok(claro[r], r);
  // los tamaños de letra salen de la escala: no hay `font-size: 13px` sueltos
  const sueltos = css.replace(/:root\{[^}]*\}/g, '').match(/font-size:\s*\d+(\.\d+)?px/g);
  assert.equal(sueltos, null, `tamaños fuera de la escala: ${sueltos}`);
  for (const t of [claro, oscuro])
    for (const n of ['--bg', '--fg', '--mut', '--card', '--top', '--blue', '--accent']) assert.ok(valor(t, n), `${n} (marca y modo oscuro por variable)`);
});

for (const [modo, t] of [
  ['claro', claro],
  ['oscuro', oscuro],
]) {
  test(`contraste AA en modo ${modo}: texto ≥ 4,5:1 e interfaz ≥ 3:1`, () => {
    const v = (n) => valor(t, n);
    const texto = [
      ...['dev', 'qa', 'pre', 'prod'].map((a) => [`etiqueta ${a}`, v(`--${a}-fg`), v(`--${a}-bg`)]),
      ['texto sobre el fondo', v('--fg'), v('--bg')],
      ['texto sobre tarjeta', v('--fg'), v('--card')],
      ['texto atenuado sobre el fondo', v('--mut'), v('--bg')],
      ['texto atenuado sobre tarjeta', v('--mut'), v('--card')],
      ['alerta', v('--alerta-fg'), v('--alerta-bg')],
      ['éxito', v('--exito-fg'), v('--exito-bg')],
      ['botón principal', '#ffffff', v('--blue')],
      ['enlace/botón secundario sobre tarjeta', modo === 'claro' ? mezcla(v('--blue'), '#000000', 0.88) : v('--accent'), v('--card')],
      ['enlace/botón secundario sobre el fondo', modo === 'claro' ? mezcla(v('--blue'), '#000000', 0.88) : v('--accent'), v('--bg')],
      ['navegación (blanco al 75 %) sobre la barra', mezcla('#ffffff', v('--top'), 0.75), v('--top')],
      ['usuario en la barra', '#b9c6df', v('--top')],
    ];
    for (const [que, fg, bg] of texto) assert.ok(ratio(fg, bg) >= 4.5, `${que}: ${ratio(fg, bg).toFixed(2)}:1 (${fg} sobre ${bg})`);
    const interfaz = [
      ['anillo de foco sobre el fondo', v('--foco'), v('--bg')],
      ['anillo de foco sobre tarjeta', v('--foco'), v('--card')],
      ['borde de campos sobre tarjeta', v('--borde-campo'), v('--card')],
      ...['bajo', 'medio', 'alto'].map((u) => [`barra de uso ${u} sobre su pista`, v(`--uso-${u}`), v('--pista')]),
      ['icono de aviso', v('--aviso'), v('--card')],
      ['icono de éxito', v('--exito'), v('--card')],
    ];
    // el porcentaje de uso se pinta con el color del umbral: es texto, así que exige 4,5:1 sobre la tarjeta
    for (const u of ['bajo', 'medio', 'alto']) texto.push([`porcentaje de uso ${u}`, v(`--uso-${u}`), v('--card')]);
    for (const [que, fg, bg] of interfaz) assert.ok(ratio(fg, bg) >= 3, `${que}: ${ratio(fg, bg).toFixed(2)}:1 (${fg} sobre ${bg})`);
  });
}

// ---- iconos ----
const cargarIconos = async () => import('data:text/javascript;base64,' + Buffer.from(leer('iconos.js')).toString('base64'));

test('iconos: un solo set, SVG con aria-hidden, currentColor y 16/20 px', async () => {
  const { ICONOS, icono } = await cargarIconos();
  assert.ok(Object.keys(ICONOS).length >= 25);
  for (const n of Object.keys(ICONOS)) {
    const s = icono(n);
    assert.match(s, /^<svg class="ic" width="16" height="16" viewBox="0 0 24 24"/, n);
    for (const a of ['aria-hidden="true"', 'focusable="false"', 'stroke="currentColor"', 'fill="none"', 'stroke-width="2"'])
      assert.ok(s.includes(a), `${n}: ${a}`);
    assert.ok(!/<script|on\w+=/i.test(s), n);
  }
  assert.match(icono('ok', 20), /class="ic ic-lg" width="20" height="20"/);
  assert.throws(() => icono('no-existe'), /Icono desconocido/);
});

test('iconos usados en la interfaz existen, y no quedan glifos Unicode como icono', async () => {
  const { ICONOS } = await cargarIconos();
  const fuentes = [
    ...fs.readdirSync(PUBLICO).filter((f) => /\.(js|html)$/.test(f) && f !== 'api.js' && f !== 'api.html'),
    ...MODULOS.map((f) => 'modulos/' + f),
  ];
  const usados = new Set();
  for (const f of fuentes) {
    const t = leer(f);
    for (const m of t.matchAll(/\b(?:I|icono)\('([\w-]+)'/g)) usados.add(m[1]);
    for (const m of t.matchAll(/data-ic="([\w-]+)"/g)) usados.add(m[1]);
    const sinComentarios = t.replace(/^\s*(\/\/|\/\*|\*).*$/gm, '').replace(/\s\/\/ .*$/gm, '');
    assert.ok(!/[⬇⬆✔✓✗✘⚠→←↑↓▶▼▲✖]/u.test(sinComentarios), `${f}: glifo Unicode usado como icono`);
  }
  assert.ok(usados.size >= 10);
  for (const n of usados) assert.ok(ICONOS[n], `falta el icono «${n}»`);
  assert.ok(!/[⬇✔⚠→]/u.test(fs.readFileSync(path.join(__dirname, 'adaptadores', 'http', 'paginas.js'), 'utf8').replace(/\/\/.*$/gm, '')), 'paginas.js');
});

// ---- estructura accesible de index.html ----
test('index.html: idioma, enlace para saltar, un h1, navegación con aria-current y sin scripts en línea', () => {
  const html = leer('index.html');
  assert.match(html, /<html lang="es">/);
  assert.match(html, /<a class="saltar" href="#contenido">/);
  assert.match(html, /<main id="contenido"/);
  assert.match(html, /<nav class="nav" id="nav" aria-label="Secciones">/);
  assert.equal((html.match(/<h1[ >]/g) || []).length, 1);
  assert.match(html, /data-t="pools"[^>]*aria-current="page"/);
  assert.match(html, /<link id="favicon" rel="icon" href="\/favicon\.svg"/);
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html));
});

// ---- específico de esta línea: etiquetas de estado, estructura y diálogos ----
test('todas las etiquetas de estado (.tag.X) con texto blanco cumplen 4,5:1', () => {
  const hex = [...css.matchAll(/\.tag\.([\w-]+)\{background:(#[0-9a-fA-F]{6})\}/g)];
  assert.ok(hex.length >= 12, `se esperaban las etiquetas de reservas, tokens e importación (hay ${hex.length})`);
  for (const [, nombre, color] of hex) assert.ok(ratio('#ffffff', color) >= 4.5, `.tag.${nombre} ${color}: ${ratio('#ffffff', color).toFixed(2)}:1`);
});

const MODULOS = fs.readdirSync(path.join(PUBLICO, 'modulos')).filter((f) => f.endsWith('.js'));
const fuentes = () => ['app.js', ...MODULOS.map((f) => 'modulos/' + f)];

test('la interfaz no usa diálogos nativos (confirm, alert, prompt) ni patrones que la CSP no admite, y es un módulo ES', () => {
  assert.match(leer('index.html'), /<script type="module" src="\/app\.js">/);
  for (const f of fuentes()) {
    const codigo = leer(f)
      .replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')
      .replace(/\s\/\/ .*$/gm, '');
    assert.ok(!/\b(alert|confirm|prompt)\(/.test(codigo), `${f}: diálogos nativos`);
    assert.ok(!/eval\(|new Function|document\.write|insertAdjacentHTML/.test(codigo), `${f}: patrones que la CSP o el escáner no admiten`);
  }
  assert.match(leer('modulos/base.js'), /^import \{ icono \} from '\.\.\/iconos\.js';/m);
});

test('módulos de la interfaz: cada importación existe, ninguno importa el punto de entrada y ninguno es gigante', () => {
  assert.ok(MODULOS.length >= 12, `se esperaban los módulos por pestaña (hay ${MODULOS.length})`);
  for (const f of fuentes()) {
    const t = leer(f);
    for (const [, ruta] of t.matchAll(/^import [^;]*? from '([^']+)';/gms)) {
      assert.ok(ruta.startsWith('.') || ruta.startsWith('/'), `${f}: ruta ${ruta}`);
      const destino = path.normalize(path.join(PUBLICO, path.dirname(f), ruta));
      assert.ok(fs.existsSync(destino), `${f} importa ${ruta}, que no existe`);
      assert.ok(!/app\.js$/.test(ruta), `${f} no debe importar el punto de entrada`);
    }
    assert.ok(t.split('\n').length <= 400, `${f} supera 400 líneas: divídelo`);
  }
});

test('index.html: enlace para saltar, h1, main, navegación con iconos y aviso de notificaciones', () => {
  const html = leer('index.html');
  assert.match(html, /<a class="saltar" href="#contenido">/);
  assert.match(html, /<main id="contenido"/);
  assert.match(html, /<nav class="nav" id="nav" aria-label="Secciones">/);
  assert.equal((html.match(/<h1[ >]/g) || []).length, 1);
  assert.match(html, /id="toasts"[^>]*aria-live="polite"/);
  assert.match(html, /<link id="favicon" rel="icon" href="\/favicon\.svg"/);
  const botones = [...html.matchAll(/<button[^>]*data-t="(\w+)"[^>]*>/g)];
  assert.ok(botones.length >= 6);
  for (const [b] of botones) assert.match(b, /data-ic="\w+"/, b);
});

test('login.html: sin scripts en línea y con el botón hacia /auth/login', () => {
  const html = leer('login.html');
  assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html));
  assert.match(html, /href="\/auth\/login"/);
  assert.match(html, /Entrar con tu cuenta corporativa/);
});
