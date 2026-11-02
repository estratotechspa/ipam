// Detalle opcional de un segmento (descripción, responsable, uso, fecha original). Datos FICTICIOS.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validarDetalle, parsearFecha } = require('./detalle');
const { analizar } = require('./importacion');

const HOY = new Date('2026-11-02T15:00:00Z');

test('parsearFecha acepta día/mes/año y año-mes-día, y fija el mediodía UTC', () => {
  assert.equal(parsearFecha('29/08/2024', HOY), '2024-08-29T12:00:00.000Z');
  assert.equal(parsearFecha('9-1-2026', HOY), '2026-01-09T12:00:00.000Z');
  assert.equal(parsearFecha('2024-08-29', HOY), '2024-08-29T12:00:00.000Z');
  assert.equal(parsearFecha('2024-08-29T00:00:00.000Z', HOY), '2024-08-29T12:00:00.000Z', 'una celda de fecha de Excel conserva el día');
});

test('parsearFecha rechaza fechas inexistentes, futuras o anteriores a 1990', () => {
  for (const f of ['31/02/2024', '2024-13-01', '01/01/1980', '05/11/2026', 'ayer', '29.08.2024']) assert.equal(parsearFecha(f, HOY), null, f);
});

test('validarDetalle: todo es opcional y se recorta', () => {
  assert.deepEqual(validarDetalle({}, HOY), { ok: true, descripcion: null, responsable: null, uso: null, creado_en: null });
  const r = validarDetalle({ descripcion: '  POC IA ', responsable: ' Ana Pérez', uso: 'Control Plane', fecha: '15/04/2026' }, HOY);
  assert.deepEqual(r, { ok: true, descripcion: 'POC IA', responsable: 'Ana Pérez', uso: 'Control Plane', creado_en: '2026-04-15T12:00:00.000Z' });
});

test('validarDetalle: límites y fecha inválida con mensaje claro', () => {
  assert.equal(validarDetalle({ descripcion: 'x'.repeat(501) }, HOY).ok, false);
  assert.equal(validarDetalle({ responsable: 'x'.repeat(121) }, HOY).ok, false);
  assert.equal(validarDetalle({ uso: 'x'.repeat(61) }, HOY).ok, false);
  assert.equal(validarDetalle({ responsable: 'Ana\u0000' }, HOY).ok, false);
  const f = validarDetalle({ fecha: '31/02/2024' }, HOY);
  assert.equal(f.ok, false);
  assert.match(f.mensaje, /Fecha inválida/);
});

test('la importación conserva ticket, fecha original, responsable, descripción y uso de cada fila', () => {
  const pools = [{ id: 'dev-gcp', tipo: 'Subred', ambiente: 'dev', proveedor: 'GCP', cidr: '172.31.128.0/17' }];
  const r = analizar({
    pools,
    ocupados: [],
    ahora: HOY,
    filas: [
      {
        n: 2,
        cidr: '172.31.130.0/23',
        vpc: 'vpc-a',
        proyecto: 'proy-a',
        subred: 'subnet-a',
        proveedor: 'GCP',
        ambiente: 'dev',
        ticket: '333893 / INIC-1',
        fecha: '14/03/2024',
        responsable: 'Ana Pérez',
        descripcion: 'Regla de fw',
        uso: 'Control Plane',
      },
      { n: 3, cidr: '172.31.132.0/24', vpc: 'vpc-a', proveedor: 'GCP', ambiente: 'dev' },
      { n: 4, cidr: '172.31.133.0/28', vpc: 'vpc-a', proveedor: 'GCP', ambiente: 'dev', fecha: '99/99/2024' },
    ],
  });
  const [a, b, c] = r.filas;
  assert.equal(a.estado, 'ok');
  assert.deepEqual(
    [a.ticket, a.creado_en, a.responsable, a.descripcion, a.uso],
    ['333893 / INIC-1', '2024-03-14T12:00:00.000Z', 'Ana Pérez', 'Regla de fw', 'Control Plane'],
  );
  assert.equal(b.estado, 'ok');
  assert.deepEqual([b.ticket, b.creado_en, b.responsable], ['IMPORTADO', null, null], 'sin datos: ticket por defecto y fecha de la importación');
  assert.equal(c.estado, 'invalida');
  assert.match(c.detalle, /Fecha inválida/);
});
