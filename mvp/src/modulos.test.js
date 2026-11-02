// Módulos apagados por configuración: responden 404 `modulo_desactivado`, incluso el webhook público; lo demás sigue igual.
const test = require('node:test');
const assert = require('node:assert/strict');
const { hayBase, crearBaseAislada, lanzarServicio } = require('./pruebas/ayudas');

const opts = { skip: hayBase ? false : 'sin DATABASE_URL' };
const ADM = { 'X-Requested-With': 'ipam', 'Content-Type': 'application/json' };

test('MODULOS_DESACTIVADOS apaga jira y direcciones (404) y deja el resto', opts, async () => {
  const b = await crearBaseAislada();
  const s = await lanzarServicio({ DATABASE_URL: b.url, MODULOS_DESACTIVADOS: 'jira,direcciones' });
  try {
    for (const [metodo, ruta] of [
      ['GET', '/api/v1/jira/estado'],
      ['POST', '/webhook/jira'],
      ['GET', '/api/v1/direcciones'],
      ['POST', '/api/v1/direcciones'],
    ]) {
      const r = await fetch(s.url + ruta, { method: metodo, headers: ADM, body: metodo === 'POST' ? '{}' : undefined });
      assert.equal(r.status, 404, `${metodo} ${ruta}`);
      assert.equal((await r.json()).error, 'modulo_desactivado');
    }
    assert.equal((await fetch(s.url + '/api/v1/pools', { headers: ADM })).status, 200);
    assert.equal((await fetch(s.url + '/readyz')).status, 200);
  } finally {
    await s.parar();
    await b.borrar();
  }
});

test('un nombre de módulo desconocido impide arrancar', opts, async () => {
  const b = await crearBaseAislada();
  try {
    await assert.rejects(lanzarServicio({ DATABASE_URL: b.url, MODULOS_DESACTIVADOS: 'jra' }));
  } finally {
    await b.borrar();
  }
});
