const test = require('node:test');
const assert = require('node:assert/strict');
const { validarNombres } = require('./nombres');

test('nombres: proyecto y subred son opcionales y se recortan', () => {
  assert.deepEqual(validarNombres({}), { ok: true, proyecto: null, subred: null });
  assert.deepEqual(validarNombres({ proyecto: '  ', subred: '' }), { ok: true, proyecto: null, subred: null });
  assert.deepEqual(validarNombres({ proyecto: ' tienda-web ', subred: ' subnet-nodos ' }), { ok: true, proyecto: 'tienda-web', subred: 'subnet-nodos' });
});

test('nombres: rechaza largos excesivos y caracteres de control', () => {
  assert.equal(validarNombres({ proyecto: 'x'.repeat(121) }).ok, false);
  assert.equal(validarNombres({ proyecto: 'x'.repeat(120) }).ok, true);
  assert.equal(validarNombres({ subred: 'x'.repeat(81) }).ok, false);
  assert.equal(validarNombres({ subred: 'a\nb' }).error, 'subred_invalido');
});
