const test = require('node:test');
const assert = require('node:assert/strict');
const { validarDireccion, validarDatos, normalizarIp, avisoDeSegmento } = require('./direccion');

test('direcciones: normaliza la IP (con o sin /32) y rechaza máscaras o textos', () => {
  assert.equal(normalizarIp(' 10.20.0.1 '), '10.20.0.1');
  assert.equal(normalizarIp('10.20.0.1/32'), '10.20.0.1');
  for (const x of ['10.20.0.0/24', '10.20.0', 'router', '300.1.1.1', '']) assert.equal(normalizarIp(x), null, x);
});

test('direcciones: datos opcionales recortados, rol por defecto «interfaz» y límites', () => {
  const r = validarDireccion({ ip: '10.0.0.1', dispositivo: ' rtr-core-01 ', interfaz: 'Gi0/1' });
  assert.deepEqual(r, {
    ok: true,
    datos: { ip: '10.0.0.1', dispositivo: 'rtr-core-01', interfaz: 'Gi0/1', dns: null, descripcion: null, excepcion: null, rol: 'interfaz' },
  });
  assert.equal(validarDatos({ rol: 'GATEWAY' }).datos.rol, 'gateway');
  assert.equal(validarDatos({ rol: 'router' }).error, 'rol_invalido');
  assert.equal(validarDatos({ dispositivo: 'x'.repeat(81) }).error, 'dispositivo_invalido');
  assert.equal(validarDatos({ interfaz: 'a\nb' }).error, 'interfaz_invalido');
});

test('direcciones: avisa si es la dirección de red o de difusión del segmento', () => {
  assert.match(avisoDeSegmento('10.0.0.0', '10.0.0.0/24'), /de red/);
  assert.match(avisoDeSegmento('10.0.0.255', '10.0.0.0/24'), /difusión/);
  assert.equal(avisoDeSegmento('10.0.0.1', '10.0.0.0/24'), null);
  assert.equal(avisoDeSegmento('10.0.0.0', '10.0.0.0/31'), null); // en /31 ambas son utilizables
});
