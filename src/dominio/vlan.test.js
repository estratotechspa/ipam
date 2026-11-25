const test = require('node:test');
const assert = require('node:assert/strict');
const { validarVlan } = require('./vlan');

test('vlan: ambos campos son opcionales', () => {
  assert.deepEqual(validarVlan({}), { ok: true, vlan: null, vlan_nombre: null });
  assert.deepEqual(validarVlan({ vlan: '', vlan_nombre: '  ' }), { ok: true, vlan: null, vlan_nombre: null });
});

test('vlan: número 1–4094 (entero o texto) y nombre recortado', () => {
  assert.deepEqual(validarVlan({ vlan: '210', vlan_nombre: '  Branch_Data ' }), { ok: true, vlan: 210, vlan_nombre: 'Branch_Data' });
  assert.deepEqual(validarVlan({ vlan: 1 }), { ok: true, vlan: 1, vlan_nombre: null });
  assert.deepEqual(validarVlan({ vlan: 4094 }), { ok: true, vlan: 4094, vlan_nombre: null });
});

test('vlan: rechaza fuera de rango, decimales, texto y nombres largos o con control', () => {
  for (const vlan of [0, 4095, -3, 1.5, 'abc']) assert.equal(validarVlan({ vlan }).ok, false, String(vlan));
  assert.equal(validarVlan({ vlan_nombre: 'x'.repeat(81) }).ok, false);
  assert.equal(validarVlan({ vlan_nombre: 'a\nb' }).ok, false);
});
