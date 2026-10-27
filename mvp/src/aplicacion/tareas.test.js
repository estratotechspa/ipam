const test = require('node:test');
const assert = require('node:assert/strict');
const { crearTareas } = require('./tareas');

test('lanzar no espera la tarea; esperar() sí, y también a las que se lanzan mientras tanto', async () => {
  const t = crearTareas();
  const orden = [];
  t.lanzar(async () => {
    await new Promise((ok) => setTimeout(ok, 30));
    orden.push('a');
    t.lanzar(async () => {
      await new Promise((ok) => setTimeout(ok, 20));
      orden.push('b');
    });
  });
  orden.push('lanzada');
  assert.equal(t.cuantas(), 1);
  assert.deepEqual(orden, ['lanzada'], 'lanzar devolvió sin esperar');
  await t.esperar();
  assert.deepEqual(orden, ['lanzada', 'a', 'b']);
  assert.equal(t.cuantas(), 0);
});

test('un error (síncrono o asíncrono) de una tarea se avisa y no se propaga', async () => {
  const avisos = [];
  const t = crearTareas({ avisar: (e) => avisos.push(e.message) });
  t.lanzar(() => {
    throw new Error('síncrono');
  });
  t.lanzar(async () => {
    throw new Error('asíncrono');
  });
  await t.esperar();
  assert.deepEqual(avisos.sort(), ['asíncrono', 'síncrono']);
  assert.equal(t.cuantas(), 0);
});

test('esperar() sin tareas pendientes termina de inmediato', async () => {
  await crearTareas().esperar();
});
