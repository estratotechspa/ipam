const test = require('node:test');
const assert = require('node:assert/strict');
const { validarPoolNuevo, chocaConPool, ancestros, cabeEnPadre } = require('./pool');

const base = { id: 'lan-sucursal', tipo: 'LAN', ambiente: 'prod', proveedor: 'On-prem', cidr: '10.40.0.0/16' };

test('pool: un pool válido se normaliza', () => {
  const r = validarPoolNuevo({ ...base, id: ' LAN-Sucursal ', ambiente: 'PROD' });
  assert.deepEqual(r, {
    ok: true,
    datos: { ...base, mascara_defecto: null, mascara_minima: null, mascara_maxima: null, proyecto: null, vpc: null, padre_id: null },
  });
});

test('pool: rechaza nombre, ambiente, CIDR desalineado y máscaras fuera de /8–/30', () => {
  assert.equal(validarPoolNuevo({ ...base, id: 'con espacios' }).error, 'id_invalido');
  assert.equal(validarPoolNuevo({ ...base, ambiente: 'test' }).error, 'ambiente_invalido');
  assert.equal(validarPoolNuevo({ ...base, cidr: '10.40.1.0/16' }).error, 'cidr_desalineado');
  assert.equal(validarPoolNuevo({ ...base, cidr: '10.0.0.0/7' }).error, 'mascara_invalida');
  assert.equal(validarPoolNuevo({ ...base, cidr: '10.40.0.0/31' }).error, 'mascara_invalida');
  assert.equal(validarPoolNuevo({ ...base, tipo: '' }).error, 'tipo_invalido');
});

test('pool: no se solapa con ningún otro, ni de otro ambiente ni de otro proveedor', () => {
  const existentes = [{ id: 'gcp-prod', tipo: 'Nodos', ambiente: 'prod', proveedor: 'GCP', cidr: '10.40.0.0/20' }];
  assert.equal(chocaConPool({ ...base, proveedor: 'gcp' }, existentes).id, 'gcp-prod');
  assert.equal(chocaConPool(base, existentes).id, 'gcp-prod'); // otro proveedor
  assert.equal(chocaConPool({ ...base, proveedor: 'GCP', ambiente: 'qa' }, existentes).id, 'gcp-prod'); // otro ambiente
  assert.equal(chocaConPool({ ...base, cidr: '10.41.0.0/16' }, existentes), null); // rango distinto
  assert.equal(chocaConPool({ ...base, id: 'gcp-prod', proveedor: 'GCP' }, existentes), null); // él mismo
});

test('pool: «lab» es un ambiente válido', () => {
  assert.equal(validarPoolNuevo({ ...base, ambiente: 'lab' }).ok, true);
});

test('pool: identidad de VPC y padre se normalizan (minúsculas) y se validan con el formato de GCP', () => {
  const r = validarPoolNuevo({ ...base, proyecto: ' Proy-Hub ', vpc: 'VPC-X', padre_id: ' Dev-GCP ' });
  assert.deepEqual([r.datos.proyecto, r.datos.vpc, r.datos.padre_id], ['proy-hub', 'vpc-x', 'dev-gcp']);
  assert.equal(validarPoolNuevo({ ...base, vpc: 'vpc con espacios' }).error, 'vpc_invalido');
  assert.equal(validarPoolNuevo({ ...base, vpc: 'vpc_x' }).error, 'vpc_invalido');
  assert.equal(validarPoolNuevo({ ...base, vpc: '1vpc' }).error, 'vpc_invalido');
  assert.equal(validarPoolNuevo({ ...base, proyecto: 'p', vpc: 'a'.repeat(64) }).error, 'vpc_invalido');
  assert.equal(validarPoolNuevo({ ...base, proyecto: 'Proy', vpc: '' }).error, 'vpc_requerida');
  assert.equal(validarPoolNuevo({ ...base, vpc: 'vpc-x', proyecto: 'p q' }).error, 'proyecto_invalido');
  assert.equal(validarPoolNuevo({ ...base, padre_id: 'no válido' }).error, 'padre_invalido');
});

test('pool anidado: solo se solapa con sus ancestros y descendientes; con cualquier otro pool, no', () => {
  const abuelo = { id: 'dev-gcp', cidr: '10.0.0.0/16', padre_id: null };
  const padre = { id: 'vpc-a', cidr: '10.0.0.0/20', padre_id: 'dev-gcp' };
  const hermano = { id: 'vpc-b', cidr: '10.0.16.0/20', padre_id: 'dev-gcp' };
  const todos = [abuelo, padre, hermano];
  assert.equal(chocaConPool({ id: 'nuevo', cidr: '10.0.32.0/20', padre_id: 'dev-gcp' }, todos), null); // libre dentro del abuelo
  assert.equal(chocaConPool({ id: 'nuevo', cidr: '10.0.8.0/21', padre_id: 'dev-gcp' }, todos).id, 'vpc-a'); // pisa a un hermano del padre
  assert.equal(chocaConPool({ id: 'nuevo', cidr: '10.0.0.0/24', padre_id: 'vpc-a' }, todos), null); // hijo del hijo: solo toca a sus ancestros
  assert.equal(chocaConPool({ id: 'nuevo', cidr: '10.0.16.0/24', padre_id: 'vpc-a' }, todos).id, 'vpc-b'); // cae en otra VPC
  assert.equal(chocaConPool({ id: 'nuevo', cidr: '10.0.0.0/24', padre_id: null }, todos).id, 'dev-gcp'); // sin padre no hereda permisos
  assert.equal(chocaConPool(abuelo, todos), null); // el abuelo ya existente solapa con sus descendientes: es válido
  assert.deepEqual(ancestros('vpc-a', todos), ['vpc-a', 'dev-gcp']);
  assert.equal(cabeEnPadre('10.0.0.0/20', '10.0.0.0/16'), true);
  assert.equal(cabeEnPadre('10.1.0.0/20', '10.0.0.0/16'), false);
});
