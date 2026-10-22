const test = require('node:test');
const assert = require('node:assert/strict');
const { reintentar, esTransitorio } = require('./resiliencia');

test('clasifica errores transitorios y definitivos', () => {
  for (const e of [
    { code: '40001' },
    { code: '40P01' },
    { code: '57P01' },
    { code: 'ECONNRESET' },
    { code: 'ETIMEDOUT' },
    new Error('Connection terminated unexpectedly'),
  ])
    assert.equal(esTransitorio(e), true);
  for (const e of [{ code: '23505' }, { code: '42601' }, { code: '23P01' }, new Error('otro')]) assert.equal(esTransitorio(e), false);
});

test('reintenta solo errores transitorios y con tope', async () => {
  let n = 0;
  assert.equal(
    await reintentar(
      async () => {
        n++;
        if (n < 3) throw Object.assign(new Error('x'), { code: 'ECONNRESET' });
        return 'listo';
      },
      { baseMs: 1, maxMs: 2 },
    ),
    'listo',
  );
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(
    reintentar(
      async () => {
        n++;
        throw Object.assign(new Error('x'), { code: '40001' });
      },
      { intentos: 3, baseMs: 1, maxMs: 2 },
    ),
  );
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(
    reintentar(
      async () => {
        n++;
        throw Object.assign(new Error('dato malo'), { code: '23505' });
      },
      { intentos: 5, baseMs: 1 },
    ),
  );
  assert.equal(n, 1, 'un error de negocio no se reintenta');
});
