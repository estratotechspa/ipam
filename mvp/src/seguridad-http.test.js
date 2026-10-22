// Seguridad HTTP: cabeceras, cookies de sesión, arranque seguro y Helm sin autenticación.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { hayBase, crearBaseAislada, lanzarServicio } = require('./pruebas/ayudas');
const S = require('./adaptadores/auth/sesion');

const opts = { skip: hayBase ? false : 'sin DATABASE_URL' };
const CHART = path.join(__dirname, '..', 'chart', 'ipam');
const hayHelm = spawnSync('helm', ['version', '--short']).status === 0;

/** Entorno mínimo para probar las cookies sin depender del proceso. */
function conEntorno(vars, fn) {
  const previo = {};
  for (const k of Object.keys(vars)) { previo[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k of Object.keys(previo)) { if (previo[k] === undefined) delete process.env[k]; else process.env[k] = previo[k]; } }
}
const cookie = (req) => { const enviadas = []; S.ponerCookie(req, { append: (n, v) => enviadas.push(v) }, 'ipam_sesion', 'valor', 3600); return enviadas[0]; };

test('cookies de sesión: siempre HttpOnly y SameSite; Secure con URL pública https o conexión HTTPS (TRUST_PROXY)', () => {
  conEntorno({ PUBLIC_URL: 'https://ipam.ejemplo.interno', COOKIE_SECURE: undefined }, () => {
    const c = cookie({ secure: false });
    assert.match(c, /; HttpOnly/);
    assert.match(c, /; SameSite=Lax/);
    assert.match(c, /; Secure/);
    assert.match(c, /Path=\//);
  });
  conEntorno({ PUBLIC_URL: 'http://localhost:8080', COOKIE_SECURE: undefined }, () => {
    assert.doesNotMatch(cookie({ secure: false }), /Secure/, 'en http local no se marca Secure (el navegador la descartaría)');
    assert.match(cookie({ secure: true }), /; Secure/, 'detrás de un proxy TLS (req.secure) sí');
    assert.match(cookie({ secure: false }), /; HttpOnly; SameSite=Lax/);
  });
  conEntorno({ PUBLIC_URL: 'http://localhost', COOKIE_SECURE: 'true' }, () => assert.match(cookie({ secure: false }), /; Secure/));
  conEntorno({ PUBLIC_URL: 'https://x.example', COOKIE_SECURE: 'false' }, () => assert.doesNotMatch(cookie({ secure: false }), /Secure/));
});

test('cabeceras de seguridad en la interfaz y la API: CSP sin scripts en línea, sin X-Powered-By, API sin caché; HSTS solo si se pide', opts, async () => {
  const b = await crearBaseAislada();
  const s = await lanzarServicio({ DATABASE_URL: b.url });
  try {
    for (const ruta of ['/', '/api/pools', '/healthz']) {
      const r = await fetch(s.url + ruta, { headers: { 'X-Requested-With': 'ipam' } });
      const h = r.headers;
      const csp = h.get('content-security-policy');
      assert.match(csp, /script-src 'self'(;|$)/, `${ruta}: CSP sin scripts en línea`);
      assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
      assert.match(csp, /object-src 'none'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /default-src 'self'/);
      assert.equal(h.get('x-content-type-options'), 'nosniff');
      assert.ok(h.get('referrer-policy'));
      assert.equal(h.get('x-powered-by'), null);
      assert.equal(h.get('strict-transport-security'), null, 'sin HSTS por defecto');
      if (ruta.startsWith('/api/')) assert.equal(h.get('cache-control'), 'no-store', 'las respuestas de la API no se guardan en cachés');
    }
    const html = await (await fetch(s.url + '/')).text();
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'la página no trae scripts en línea');
    assert.ok(!/\son[a-z]+\s*=/i.test(html), 'ni manejadores de eventos en línea');
  } finally { await s.parar(); await b.borrar(); }
  const b2 = await crearBaseAislada();
  const s2 = await lanzarServicio({ DATABASE_URL: b2.url, HSTS: 'true' });
  try { assert.match((await fetch(s2.url + '/healthz')).headers.get('strict-transport-security'), /max-age=/); } finally { await s2.parar(); await b2.borrar(); }
});

test('con TRUST_PROXY la IP del cliente sale de X-Forwarded-For (para el límite de peticiones y la auditoría)', opts, async () => {
  const b = await crearBaseAislada();
  const s = await lanzarServicio({ DATABASE_URL: b.url, TRUST_PROXY: '1' });
  try {
    await fetch(s.url + '/api/solicitudes', { method: 'POST', headers: { 'X-Requested-With': 'ipam', 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.7' }, body: JSON.stringify({ pool: 'gke-nodos-qa', vpc: 'ip', mascara: 28 }) });
    assert.equal((await b.sql("select ip from auditoria where accion = 'asignar'")).rows[0].ip, '203.0.113.7');
  } finally { await s.parar(); await b.borrar(); }
  const b2 = await crearBaseAislada();
  const s2 = await lanzarServicio({ DATABASE_URL: b2.url }); // sin TRUST_PROXY: la cabecera NO se cree
  try {
    await fetch(s2.url + '/api/solicitudes', { method: 'POST', headers: { 'X-Requested-With': 'ipam', 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.7' }, body: JSON.stringify({ pool: 'gke-nodos-qa', vpc: 'ip', mascara: 28 }) });
    assert.notEqual((await b2.sql("select ip from auditoria where accion = 'asignar'")).rows[0].ip, '203.0.113.7');
  } finally { await s2.parar(); await b2.borrar(); }
});

const helm = (...args) => spawnSync('helm', ['template', 'ipam', CHART, ...args], { encoding: 'utf8' });
const conHelm = hayHelm ? {} : { skip: 'sin helm' };

test('Helm: sin autenticación configurada la plantilla FALLA con un mensaje claro', conHelm, () => {
  const r = helm();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /autenticación/i);
  assert.match(r.stderr, /allowAnonymous|oidc|appUser|existingSecret/);
});

test('Helm: renderiza con allowAnonymous, con appUser, con existingSecret o con OIDC; y trae los TTL de reservas', conHelm, () => {
  for (const args of [['--set', 'auth.allowAnonymous=true'], ['--set', 'secrets.appUser=admin'], ['--set', 'secrets.existingSecret=mis-secretos'],
    ['--set', 'auth.oidc.issuer=https://accounts.google.com', '--set', 'auth.oidc.clientId=x', '--set', 'secrets.oidcClientSecret=y', '--set', 'config.publicUrl=https://ipam.ejemplo.interno']]) {
    const r = helm(...args);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stdout, /RESERVA_TTL_HORAS: "24"/);
    assert.match(r.stdout, /RESERVA_TTL_MAX_HORAS: "72"/);
  }
  const anon = helm('--set', 'auth.allowAnonymous=true');
  assert.match(anon.stdout, /ALLOW_ANONYMOUS: "true"/);
  const sinAnon = helm('--set', 'secrets.appUser=admin');
  assert.match(sinAnon.stdout, /ALLOW_ANONYMOUS: "false"/, 'por defecto el chart NO permite acceso anónimo');
  const ttl = helm('--set', 'auth.allowAnonymous=true', '--set', 'config.reservaTtlHoras=12', '--set', 'config.reservaTtlMaxHoras=48');
  assert.match(ttl.stdout, /RESERVA_TTL_HORAS: "12"/);
  assert.match(ttl.stdout, /RESERVA_TTL_MAX_HORAS: "48"/);
});

test('Helm: los límites de peticiones y la cuota por token son configurables con valores seguros por defecto', conHelm, () => {
  const defecto = helm('--set', 'auth.allowAnonymous=true').stdout;
  for (const [k, v] of [['RATE_LIMIT_POR_MINUTO', 120], ['RATE_LIMIT_ESCRITURA_POR_MINUTO', 30], ['RATE_LIMIT_IP_POR_MINUTO', 600], ['RATE_LIMIT_AUTH_FALLOS_POR_MINUTO', 10], ['CUOTA_RESERVAS_POR_TOKEN', 20]]) {
    assert.match(defecto, new RegExp(`${k}: "${v}"`));
  }
  const otro = helm('--set', 'auth.allowAnonymous=true', '--set', 'limites.porMinuto=60', '--set', 'limites.cuotaReservasPorToken=5').stdout;
  assert.match(otro, /RATE_LIMIT_POR_MINUTO: "60"/);
  assert.match(otro, /CUOTA_RESERVAS_POR_TOKEN: "5"/);
});
