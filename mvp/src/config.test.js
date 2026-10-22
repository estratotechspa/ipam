const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { config, validar, validarOFallar, listarVariables, ErrorDeConfiguracion } = require('./config');

/** Ejecuta `fn` con estas variables (undefined = borrar) y restaura el entorno al terminar. */
function conEntorno(vars, fn) {
  const previo = {};
  for (const k of Object.keys(vars)) { previo[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k of Object.keys(previo)) { if (previo[k] === undefined) delete process.env[k]; else process.env[k] = previo[k]; } }
}
const LIMPIO = Object.fromEntries(listarVariables().flatMap((v) => [[v.nombre, undefined], [`${v.nombre}_FILE`, undefined]]));

test('valores por defecto seguros', () => conEntorno(LIMPIO, () => {
  assert.equal(config.http.puerto, 8080);
  assert.equal(config.rol, 'todos');
  assert.equal(config.produccion, false);
  assert.equal(config.reservas.ttlHoras, 24);
  assert.equal(config.reservas.ttlMaxHoras, 72);
  assert.equal(config.bd.esquema, 'public');
  assert.equal(config.bd.migrarAlArrancar, false);
  assert.equal(config.auth.permitirAnonimo, false);
  assert.equal(config.auth.modo, 'none');
  assert.equal(config.limite.lecturaPorMinuto, 120);
  assert.equal(config.limite.escrituraPorMinuto, 30);
  assert.equal(config.limite.cuotaReservasPorToken, 20);
  assert.equal(config.otel.activo, false);
  assert.deepEqual(config.eventos.publicadores, ['log']);
  assert.equal(config.http.trustProxy, undefined);
}));

test('TRUST_PROXY: número de saltos o nombre', () => {
  conEntorno({ TRUST_PROXY: '2' }, () => assert.equal(config.http.trustProxy, 2));
  conEntorno({ TRUST_PROXY: 'loopback' }, () => assert.equal(config.http.trustProxy, 'loopback'));
  conEntorno({ TRUST_PROXY: 'false' }, () => assert.equal(config.http.trustProxy, undefined));
});

test('secretos por archivo (NOMBRE_FILE): lee el archivo, quita el salto de línea final y sigue los cambios', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipam-cfg-'));
  const f = path.join(dir, 'url');
  fs.writeFileSync(f, 'postgres://u:p@h:5432/d\n');
  conEntorno({ DATABASE_URL: undefined, DATABASE_URL_FILE: f }, () => {
    assert.equal(config.bd.url, 'postgres://u:p@h:5432/d');
    fs.writeFileSync(f, 'postgres://u:otra-clave-mas-larga@h:5432/d\r\n'); // rotación del secreto montado
    assert.equal(config.bd.url, 'postgres://u:otra-clave-mas-larga@h:5432/d');
  });
  // La variable directa gana y se avisa.
  conEntorno({ DATABASE_URL: 'postgres://directa', DATABASE_URL_FILE: f }, () => {
    assert.equal(config.bd.url, 'postgres://directa');
    assert.ok(validar().avisos.some((a) => /DATABASE_URL y DATABASE_URL_FILE/.test(a)));
  });
  fs.rmSync(dir, { recursive: true });
});

test('NOMBRE_FILE funciona para cualquier variable (p. ej. METRICS_TOKEN) y un archivo ausente da un error claro', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipam-cfg-'));
  fs.writeFileSync(path.join(dir, 'm'), 'token-de-metricas');
  conEntorno({ METRICS_TOKEN: undefined, METRICS_TOKEN_FILE: path.join(dir, 'm') }, () => assert.equal(config.metricas.token, 'token-de-metricas'));
  conEntorno({ METRICS_TOKEN: undefined, METRICS_TOKEN_FILE: path.join(dir, 'no-existe') }, () => assert.throws(() => config.metricas.token, ErrorDeConfiguracion));
  fs.rmSync(dir, { recursive: true });
});

test('validación: reúne TODOS los problemas y no muestra secretos', () => {
  conEntorno({ ...LIMPIO, NODE_ENV: 'production', PORT: 'abc', DB_POOL_MAX: '0', RESERVA_TTL_HORAS: '100', DATABASE_URL: undefined, APP_PASS: 'SuperSecreta' }, () => {
    const { errores } = validar();
    const todo = errores.join('\n');
    assert.match(todo, /PORT debe ser un entero/);
    assert.match(todo, /DB_POOL_MAX debe ser un entero/);
    assert.match(todo, /Falta DATABASE_URL/);
    assert.match(todo, /APP_USER y APP_PASS juntos/);
    assert.doesNotMatch(todo, /SuperSecreta/);
    assert.throws(() => validarOFallar(), (e) => e instanceof ErrorDeConfiguracion && e.problemas.length >= 4);
  });
});

test('arranque seguro: producción sin autenticación se niega, salvo ALLOW_ANONYMOUS=true', () => {
  const base = { ...LIMPIO, NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@h/d' };
  conEntorno(base, () => assert.match(validar().errores.join('\n'), /NODE_ENV=production sin autenticación/));
  conEntorno({ ...base, ALLOW_ANONYMOUS: 'true' }, () => {
    const r = validar();
    assert.deepEqual(r.errores, []);
    assert.ok(r.avisos.some((a) => /ALLOW_ANONYMOUS=true/.test(a)));
  });
  conEntorno({ ...base, APP_USER: 'admin', APP_PASS: 'x' }, () => {
    const r = validar();
    assert.deepEqual(r.errores, []);
    assert.ok(r.avisos.some((a) => /Modo Basic/.test(a)), 'modo Basic avisa en el log al arrancar');
    assert.ok(r.avisos.some((a) => /texto plano/.test(a)));
  });
  conEntorno({ ...base, APP_USER: 'admin', APP_PASS: 'scrypt$16384$8$1$c2Fs$aGFzaA==' }, () => assert.ok(!validar().avisos.some((a) => /texto plano/.test(a))));
  // En desarrollo el modo abierto no estorba.
  conEntorno({ ...LIMPIO, DATABASE_URL: 'postgres://u:p@h/d' }, () => assert.deepEqual(validar().errores, []));
});

test('OIDC exige cliente, secreto, URL pública y una clave de sesión de al menos 32 caracteres', () => {
  conEntorno({ ...LIMPIO, DATABASE_URL: 'postgres://u:p@h/d', OIDC_ISSUER: 'https://idp.example' }, () => assert.match(validar().errores.join('\n'), /faltan variables OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, PUBLIC_URL, SESSION_SECRET/));
  conEntorno({ ...LIMPIO, DATABASE_URL: 'postgres://u:p@h/d', OIDC_ISSUER: 'https://idp.example', OIDC_CLIENT_ID: 'a', OIDC_CLIENT_SECRET: 'b', PUBLIC_URL: 'https://x', SESSION_SECRET: 'corta' },
    () => assert.match(validar().errores.join('\n'), /al menos 32/));
});

test('el TTL por defecto no puede superar el máximo; el esquema debe ser un identificador simple', () => {
  conEntorno({ ...LIMPIO, DATABASE_URL: 'postgres://u:p@h/d', RESERVA_TTL_HORAS: '48', RESERVA_TTL_MAX_HORAS: '24' }, () => assert.match(validar().errores.join('\n'), /RESERVA_TTL_HORAS no puede superar/));
  conEntorno({ ...LIMPIO, DATABASE_URL: 'postgres://u:p@h/d', DATABASE_SCHEMA: 'ipam; drop table x' }, () => assert.match(validar().errores.join('\n'), /DATABASE_SCHEMA/));
});

test('el webhook de eventos y OTLP piden sus datos; Jira sin secreto en producción queda deshabilitado', () => {
  const b = { ...LIMPIO, DATABASE_URL: 'postgres://u:p@h/d', ALLOW_ANONYMOUS: 'true' };
  conEntorno({ ...b, EVENTOS_PUBLICADORES: 'log,webhook' }, () => assert.match(validar().errores.join('\n'), /EVENTOS_WEBHOOK_URL y EVENTOS_WEBHOOK_SECRET/));
  conEntorno({ ...b, EVENTOS_PUBLICADORES: 'pubsub' }, () => assert.match(validar().errores.join('\n'), /adaptador desconocido/));
  conEntorno({ ...b, OTEL_TRACES_EXPORTER: 'otlp' }, () => assert.match(validar().errores.join('\n'), /OTEL_EXPORTER_OTLP_ENDPOINT/));
  conEntorno({ ...LIMPIO, NODE_ENV: 'production' }, () => assert.equal(config.webhookJira.secreto, ''));
  conEntorno({ ...LIMPIO }, () => assert.equal(config.webhookJira.secreto, 'dev-secret-cambiar'));
});

test('catálogo: cada variable está documentada y las secretas no tienen valor por defecto', () => {
  for (const v of listarVariables()) {
    assert.ok(v.descripcion && v.descripcion.length > 10, `${v.nombre} sin descripción`);
    if (v.secreta) assert.ok(v.defecto === '' || v.defecto === undefined, `${v.nombre} es secreta y trae un valor por defecto`);
  }
});
