const test = require('node:test');
const assert = require('node:assert/strict');
const { apagado, desconocidos, NOMBRES } = require('./modulos');

test('módulos: una ruta se apaga solo si su módulo está en la lista', () => {
  assert.equal(apagado(['jira'], '/webhook/jira'), true);
  assert.equal(apagado(['jira'], '/api/v1/jira/estado'), true);
  assert.equal(apagado(['jira'], '/api/v1/reservas'), false);
  assert.equal(apagado([], '/webhook/jira'), false);
  assert.equal(apagado(['importacion'], '/api/v1/importaciones/simular'), true);
  assert.equal(apagado(['importacion'], '/api/v1/importar'), false, 'restaurar un respaldo es otro módulo');
  assert.equal(apagado(['respaldo'], '/api/v1/importar'), true);
  assert.equal(apagado(['respaldo', 'excel'], '/api/v1/exportar.xlsx'), true);
  assert.equal(apagado(['direcciones'], '/api/v1/direcciones/5'), true);
  for (const nunca of ['/healthz', '/readyz', '/metrics', '/auth/login', '/api/config', '/api/v1/me']) assert.equal(apagado(NOMBRES, nunca), false, nunca);
});

test('módulos: detecta nombres desconocidos', () => {
  assert.deepEqual(desconocidos(['jira', 'jra', 'x']), ['jra', 'x']);
});
