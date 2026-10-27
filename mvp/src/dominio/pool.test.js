const test = require('node:test');
const assert = require('node:assert/strict');
const { validarPoolNuevo, chocaConPool } = require('./pool');

const base = { id: 'lan-sucursal', tipo: 'LAN', ambiente: 'prod', proveedor: 'On-prem', cidr: '10.40.0.0/16' };

test('pool: un pool válido se normaliza', () => {
  const r = validarPoolNuevo({ ...base, id: ' LAN-Sucursal ', ambiente: 'PROD' });
  assert.deepEqual(r, { ok: true, datos: { ...base } });
});

test('pool: rechaza nombre, ambiente, CIDR desalineado y máscaras fuera de /8–/30', () => {
  assert.equal(validarPoolNuevo({ ...base, id: 'con espacios' }).error, 'id_invalido');
  assert.equal(validarPoolNuevo({ ...base, ambiente: 'test' }).error, 'ambiente_invalido');
  assert.equal(validarPoolNuevo({ ...base, cidr: '10.40.1.0/16' }).error, 'cidr_desalineado');
  assert.equal(validarPoolNuevo({ ...base, cidr: '10.0.0.0/7' }).error, 'mascara_invalida');
  assert.equal(validarPoolNuevo({ ...base, cidr: '10.40.0.0/31' }).error, 'mascara_invalida');
  assert.equal(validarPoolNuevo({ ...base, tipo: '' }).error, 'tipo_invalido');
});

test('pool: no se solapa con otro del mismo proveedor y ambiente; entre ambientes o proveedores distintos sí puede', () => {
  const existentes = [{ id: 'gcp-prod', tipo: 'Nodos', ambiente: 'prod', proveedor: 'GCP', cidr: '10.40.0.0/20' }];
  assert.equal(chocaConPool({ ...base, proveedor: 'gcp' }, existentes).id, 'gcp-prod');
  assert.equal(chocaConPool(base, existentes), null); // otro proveedor
  assert.equal(chocaConPool({ ...base, proveedor: 'GCP', ambiente: 'qa' }, existentes), null); // otro ambiente
  assert.equal(chocaConPool({ ...base, id: 'gcp-prod', proveedor: 'GCP' }, existentes), null); // él mismo
});
