const test = require('node:test');
const assert = require('node:assert/strict');
const { grupoDe, permite, validarAlcance, NOMBRES } = require('./alcance');

test('alcance: cada petición cae en su grupo y las rutas de admin en ninguno', () => {
  assert.equal(grupoDe('POST', '/api/v1/reservas'), 'reservas');
  assert.equal(grupoDe('post', '/api/v1/reservas/3f2c1a9e-0000-4000-8000-000000000000/confirmar'), 'reservas');
  assert.equal(grupoDe('GET', '/api/v1/pools/dev-nodos/disponibilidad'), 'consulta');
  assert.equal(grupoDe('GET', '/api/v1/asignaciones'), 'consulta');
  assert.equal(grupoDe('PATCH', '/api/v1/direcciones/7'), 'direcciones');
  assert.equal(grupoDe('GET', '/api/v1/me'), '*');
  for (const [m, c] of [
    ['POST', '/api/v1/pools'],
    ['DELETE', '/api/v1/asignaciones/1'],
    ['GET', '/api/v1/usuarios'],
    ['GET', '/api/v1/exportar.xlsx'],
    ['GET', '/api/v1/eventos'],
  ])
    assert.equal(grupoDe(m, c), undefined, `${m} ${c}`);
  assert.equal(grupoDe('GET', '/api/v1/reservas/x/y/z'), undefined, 'no confunde rutas más largas');
});

test('alcance: null permite todo; con alcance solo sus grupos y lo siempre permitido', () => {
  assert.equal(permite(null, 'DELETE', '/api/v1/asignaciones/1'), true);
  assert.equal(permite(['consulta'], 'GET', '/api/v1/asignaciones'), true);
  assert.equal(permite(['consulta'], 'POST', '/api/v1/reservas'), false);
  assert.equal(permite(['reservas'], 'GET', '/api/v1/me'), true);
  assert.equal(permite(['reservas'], 'GET', '/api/v1/exportar.xlsx'), false);
});

test('alcance: validar la lista pedida', () => {
  assert.deepEqual(validarAlcance(undefined), { ok: true, alcance: null });
  assert.deepEqual(validarAlcance(['consulta', 'reservas', 'consulta']), { ok: true, alcance: ['reservas', 'consulta'] });
  for (const malo of [[], ['otro'], 'reservas', [1], ['reservas', 'admin']]) assert.equal(validarAlcance(malo).ok, false, JSON.stringify(malo));
  assert.deepEqual(NOMBRES, ['reservas', 'consulta', 'direcciones']);
});
