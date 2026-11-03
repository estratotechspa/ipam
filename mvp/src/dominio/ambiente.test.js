const test = require('node:test');
const assert = require('node:assert/strict');
const { AMBIENTES, normalizarAmbiente } = require('./ambiente');

test('«prd» es alias de «prod»; lo demás pasa igual y los inválidos no se inventan', () => {
  assert.equal(normalizarAmbiente('prd'), 'prod');
  assert.equal(normalizarAmbiente(' PRD '), 'prod');
  for (const a of AMBIENTES) assert.equal(normalizarAmbiente(a), a);
  assert.equal(normalizarAmbiente('staging'), 'staging');
  assert.equal(normalizarAmbiente(undefined), undefined);
});
