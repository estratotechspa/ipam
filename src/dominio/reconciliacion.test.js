// @ts-check
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { reconciliarSubredes } = require('./reconciliacion');

test('reconciliacion: sincronia perfecta cuando nube e IPAM coinciden', () => {
  const nube = [
    { cidr: '10.10.1.0/24', proyecto: 'mi-proyecto', vpc: 'vpc-dev', subred: 'sub-app' },
    { cidr: '10.10.2.0/24', proyecto: 'mi-proyecto', vpc: 'vpc-dev', subred: 'sub-db' },
  ];
  const ipam = [
    { codigo: 'ASG-000001', cidr: '10.10.1.0/24', proyecto: 'mi-proyecto', vpc: 'vpc-dev', subred: 'sub-app' },
    { codigo: 'ASG-000002', cidr: '10.10.2.0/24', proyecto: 'mi-proyecto', vpc: 'vpc-dev', subred: 'sub-db' },
  ];

  const res = reconciliarSubredes(nube, ipam);
  assert.equal(res.resumen.hay_drift, false);
  assert.equal(res.resumen.sincronizadas, 2);
  assert.equal(res.resumen.desviaciones_no_registradas, 0);
  assert.equal(res.resumen.huerfanas_en_ipam, 0);
  assert.equal(res.resumen.porcentaje_alineacion, 100);
});

test('reconciliacion: detecta subred en nube no registrada en IPAM (drift no registrado)', () => {
  const nube = [
    { cidr: '10.10.1.0/24', proyecto: 'mi-proyecto', vpc: 'vpc-dev' },
    { cidr: '10.10.99.0/24', proyecto: 'mi-proyecto', vpc: 'vpc-dev' }, // Creada manualmente en cloud
  ];
  const ipam = [{ codigo: 'ASG-000001', cidr: '10.10.1.0/24', proyecto: 'mi-proyecto', vpc: 'vpc-dev' }];

  const res = reconciliarSubredes(nube, ipam);
  assert.equal(res.resumen.hay_drift, true);
  assert.equal(res.resumen.sincronizadas, 1);
  assert.equal(res.resumen.desviaciones_no_registradas, 1);
  assert.equal(res.desviaciones_no_registradas[0].cidr, '10.10.99.0/24');
});

test('reconciliacion: detecta asignacion huerfana en IPAM (borrada en cloud)', () => {
  const nube = [{ cidr: '10.10.1.0/24', proyecto: 'mi-proyecto', vpc: 'vpc-dev' }];
  const ipam = [
    { codigo: 'ASG-000001', cidr: '10.10.1.0/24', proyecto: 'mi-proyecto', vpc: 'vpc-dev' },
    { codigo: 'ASG-000002', cidr: '10.10.2.0/24', proyecto: 'mi-proyecto', vpc: 'vpc-dev' }, // Ya no existe en cloud
  ];

  const res = reconciliarSubredes(nube, ipam);
  assert.equal(res.resumen.hay_drift, true);
  assert.equal(res.resumen.huerfanas_en_ipam, 1);
  assert.equal(res.huerfanas_en_ipam[0].codigo, 'ASG-000002');
});

test('reconciliacion: detecta discrepancias de metadatos (mismo CIDR pero distinta VPC o proyecto)', () => {
  const nube = [{ cidr: '10.10.1.0/24', proyecto: 'proyecto-nuevo', vpc: 'vpc-dev' }];
  const ipam = [{ codigo: 'ASG-000001', cidr: '10.10.1.0/24', proyecto: 'proyecto-viejo', vpc: 'vpc-dev' }];

  const res = reconciliarSubredes(nube, ipam);
  assert.equal(res.resumen.hay_drift, true);
  assert.equal(res.resumen.discrepancias_metadatos, 1);
  assert.match(res.discrepancias_metadatos[0].diferencias[0], /Proyecto distinto/);
});

test('reconciliacion: detecta choques parciales donde subred nube solapa con asignacion IPAM', () => {
  const nube = [
    { cidr: '10.10.1.0/25', vpc: 'vpc-dev' }, // Rango /25 que cae dentro de un /24 de IPAM
  ];
  const ipam = [{ codigo: 'ASG-000001', cidr: '10.10.1.0/24', vpc: 'vpc-dev' }];

  const res = reconciliarSubredes(nube, ipam);
  assert.equal(res.resumen.choques_parciales, 1);
  assert.equal(res.choques_parciales[0].asignacionIpam.codigo, 'ASG-000001');
});
