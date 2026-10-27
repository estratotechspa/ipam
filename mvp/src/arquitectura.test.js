// Pruebas de arquitectura y portabilidad: no dependen de la base de datos.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { VERSION_MINIMA } = require('./adaptadores/persistencia/postgres/esquema');

const MVP = path.join(__dirname, '..');
const GUARDIA = path.join(MVP, '..', 'scripts', 'verificar-portabilidad.sh');
const correrGuardia = (env = {}) => spawnSync('sh', [GUARDIA], { env: { ...process.env, ...env }, encoding: 'utf8' });

test('la guardia de portabilidad pasa sobre el código actual', () => {
  const r = correrGuardia();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Guardia de portabilidad: OK/);
});

test('la guardia FALLA ante un SDK de proveedor, un import de infraestructura en el dominio o process.env fuera de config', () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'ipam-guardia-'));
  fs.cpSync(path.join(MVP, 'src'), path.join(t, 'src'), { recursive: true });
  const proveedor = ['google', 'apis'].join(''); // se arma en tiempo de ejecución para no ensuciar este archivo
  fs.writeFileSync(path.join(t, 'src', 'dominio', 'malo.js'), "const pg = require('pg');\n");
  fs.writeFileSync(path.join(t, 'src', 'aplicacion', 'malo2.js'), "const a = require('../adaptadores/http/app');\n");
  fs.writeFileSync(path.join(t, 'src', 'adaptadores', 'malo3.js'), `const x = process.env.ALGO; // ${proveedor}\n`);
  const r = correrGuardia({ IPAM_SRC: path.join(t, 'src'), IPAM_PKG: '/dev/null' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /malo\.js/);
  assert.match(r.stdout, /malo2\.js/);
  assert.match(r.stdout, /malo3\.js/);
  fs.rmSync(t, { recursive: true });
});

test('el esquema del chart es idéntico al de db/', () => {
  const a = fs.readFileSync(path.join(MVP, 'db', 'schema.sql'));
  const b = fs.readFileSync(path.join(MVP, 'chart', 'ipam', 'files', 'schema.sql'));
  assert.ok(a.equals(b), 'mvp/db/schema.sql y mvp/chart/ipam/files/schema.sql deben ser idénticos');
});

test('VERSION_MINIMA coincide con la última versión que registra db/schema.sql', () => {
  const sql = fs.readFileSync(path.join(MVP, 'db', 'schema.sql'), 'utf8');
  const versiones = [...sql.matchAll(/insert into esquema_version \(version, descripcion\) values \((\d+),/g)].map((m) => Number(m[1]));
  assert.ok(versiones.length > 0);
  assert.equal(Math.max(...versiones), VERSION_MINIMA);
});

test('el dominio y la aplicación son puros: no importan Express, SQL, red ni adaptadores', () => {
  for (const capa of ['dominio', 'aplicacion']) {
    for (const f of fs.readdirSync(path.join(__dirname, capa)).filter((n) => n.endsWith('.js') && !n.endsWith('.test.js'))) {
      const txt = fs.readFileSync(path.join(__dirname, capa, f), 'utf8');
      for (const m of txt.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
        assert.match(m[1], /^\.\.?\/(?!adaptadores|config|server|arranque)/, `${capa}/${f} importa «${m[1]}»`);
      }
    }
  }
});
