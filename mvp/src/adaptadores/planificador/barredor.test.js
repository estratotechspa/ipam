const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { crearPlanificador } = require('./barredor');

const log = { error() {} };
const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));

test('ejecuta periódicamente y nunca se solapa consigo mismo', async () => {
  let activas = 0, maximo = 0, veces = 0;
  const p = crearPlanificador({ intervaloMs: 10, log, ejecutar: async () => { activas++; maximo = Math.max(maximo, activas); veces++; await dormir(30); activas--; } });
  p.iniciar();
  await dormir(250);
  await p.detener();
  assert.ok(veces >= 2, `corrió ${veces} veces`);
  assert.equal(maximo, 1);
  assert.equal(p.activo, false);
});

test('un fallo no detiene el barredor', async () => {
  let veces = 0;
  const p = crearPlanificador({ intervaloMs: 10, log, ejecutar: async () => { veces++; throw new Error('boom'); } });
  p.iniciar();
  await dormir(150);
  await p.detener();
  assert.ok(veces >= 2);
});

test('detener() espera a la ejecución en curso', async () => {
  let terminada = false;
  const p = crearPlanificador({ intervaloMs: 5, log, ejecutar: async () => { await dormir(80); terminada = true; } });
  p.iniciar();
  await dormir(30);
  await p.detener();
  assert.equal(terminada, true);
});

test('el temporizador usa unref(): por sí solo no mantiene vivo el proceso', () => {
  const codigo = `const { crearPlanificador } = require(${JSON.stringify(path.join(__dirname, 'barredor.js'))});
    crearPlanificador({ intervaloMs: 60000, log: {}, ejecutar: async () => {} }).iniciar();`;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['-e', codigo], { timeout: 5000 });
  assert.equal(r.status, 0);
  assert.ok(Date.now() - t0 < 4000, 'el proceso terminó sin esperar al temporizador');
});
