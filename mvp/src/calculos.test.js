// Lógica pura del navegador (public/js/calculos.js): se carga como módulo desde su archivo, sin DOM ni servidor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('./cidr');

const cargar = () => import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'calculos.js')).toString('base64'));

test('umbrales de uso: verde < 70 %, ámbar 70–90 %, rojo > 90 %', async () => {
  const { nivelUso } = await cargar();
  for (const [uso, nivel] of [[0, 'bajo'], [0.5, 'bajo'], [0.6999, 'bajo'], [0.7, 'medio'], [0.75, 'medio'], [0.9, 'medio'], [0.9001, 'alto'], [0.938, 'alto'], [1, 'alto']]) {
    assert.equal(nivelUso(uso), nivel, `uso ${uso}`);
  }
});

test('porcentaje con coma decimal y resumen del tablero', async () => {
  const { porcentaje, resumirPools } = await cargar();
  assert.equal(porcentaje(0.0512), '5,1 %');
  assert.equal(porcentaje(0.938), '93,8 %');
  assert.equal(porcentaje(1, 0), '100 %');
  const r = resumirPools([
    { uso: 0.5, asignaciones: 2, libres: 100 }, { uso: 0.8, asignaciones: 1, libres: 50 }, { uso: 0.81, asignaciones: 4, libres: 10 }, { uso: 0.95, asignaciones: 3, libres: 1 },
  ]);
  assert.equal(r.pools, 4);
  assert.equal(r.asignaciones, 10);
  assert.equal(r.sobre80, 2, '80 % exacto no cuenta como «sobre 80 %»');
  assert.equal(r.libres, 161);
  assert.ok(Math.abs(r.usoPromedio - 0.765) < 1e-9);
  assert.deepEqual(resumirPools([]), { pools: 0, asignaciones: 0, usoPromedio: 0, sobre80: 0, libres: 0 });
});

test('parseCidr coincide con el del servidor (src/cidr.js)', async () => {
  const { parseCidr } = await cargar();
  for (const c of ['10.64.8.0/22', '10.64.9.0/22', '192.168.0.1/32', '0.0.0.0/0', '255.255.255.255/32', '10.0.0.0/33', '10.0.0.256/24', '10.0.0/24', 'hola', '', '10.0.0.0', '1.2.3.4/8']) {
    const a = parseCidr(c), b = parse(c);
    if (!b) { assert.equal(a, null, c); continue; }
    assert.deepEqual([a.ip, a.len, a.tamano, a.inicio, a.fin, a.alineado], [b.ip, b.len, b.size, b.start, b.end, b.aligned], c);
  }
});

test('validarCidr: vacío, formato, máscara, alineación (con sugerencia) y fuera del pool', async () => {
  const { validarCidr } = await cargar();
  const pool = '10.64.0.0/12';
  assert.equal(validarCidr('', pool).estado, 'vacio');
  assert.equal(validarCidr('   ', pool).estado, 'vacio');
  const ok = validarCidr('10.64.8.0/22', pool);
  assert.deepEqual([ok.estado, ok.mensaje], ['ok', '10.64.8.0/22 · 1.024 direcciones']);
  const casos = [
    ['hola', /Formato inválido/], ['10.64.8.0', /Falta la máscara/], ['10.64.8.0/', /Falta la máscara/], ['10.64.8/22', /cuatro números/],
    ['10.64.8.300/22', /entre 0 y 255/], ['10.64.8.0/33', /entre \/0 y \/32/], ['10.64.8.0/22/1', /Formato inválido/], ['10.64.8.0/2a', /Formato inválido/],
  ];
  for (const [texto, patron] of casos) {
    const v = validarCidr(texto, pool);
    assert.equal(v.estado, 'error', texto);
    assert.match(v.mensaje, patron, texto);
  }
  const noAlineado = validarCidr('10.64.9.0/22', pool);
  assert.equal(noAlineado.estado, 'error');
  assert.match(noAlineado.mensaje, /no está alineado.*¿Quisiste decir 10\.64\.8\.0\/22\?/);
  assert.match(validarCidr('11.0.0.0/22', pool).mensaje, /queda fuera del pool 10\.64\.0\.0\/12/);
  assert.match(validarCidr('10.0.0.0/8', pool).mensaje, /fuera del pool/, 'más grande que el pool');
  assert.equal(validarCidr('11.0.0.0/22').estado, 'ok', 'sin pool no se compara');
  // lo que el cliente da por válido, el servidor lo acepta como CIDR alineado
  for (const t of ['10.64.8.0/22', '192.168.1.0/24', '10.0.0.0/8', '1.2.3.4/32']) { const p = parse(t); assert.ok(p && p.aligned, t); assert.equal(validarCidr(t).estado, 'ok', t); }
});

test('mapa de bloques: libre, parcial y ocupado; granularidad de hasta 256 bloques', async () => {
  const { mapaBloques } = await cargar();
  const vacio = mapaBloques('10.0.0.0/16', []);
  assert.equal(vacio.granularidad, 24);
  assert.equal(vacio.bloques.length, 256);
  assert.deepEqual(vacio.resumen, { libre: 256, parcial: 0, ocupado: 0 });
  assert.equal(vacio.bloques[0].cidr, '10.0.0.0/24');
  assert.equal(vacio.bloques[255].cidr, '10.0.255.0/24');

  // /22 = 4 bloques /24 ocupados; /26 dentro de otro /24 = parcial; el resto, libre
  const m = mapaBloques('10.0.0.0/16', [
    { cidr: '10.0.0.0/22', vpc: 'a', ticket: 'T-1' }, { cidr: '10.0.8.64/26', vpc: 'b', ticket: 'T-2' }, { cidr: '10.0.8.128/26', vpc: 'c', ticket: 'T-3' },
  ]);
  assert.deepEqual(m.resumen, { libre: 251, parcial: 1, ocupado: 4 });
  assert.deepEqual(m.bloques.slice(0, 5).map((b) => b.estado), ['ocupado', 'ocupado', 'ocupado', 'ocupado', 'libre']);
  assert.equal(m.bloques[8].estado, 'parcial');
  assert.deepEqual(m.bloques[8].asignaciones.map((a) => a.ticket), ['T-2', 'T-3']);
  assert.equal(m.bloques[1].asignaciones[0].ticket, 'T-1', 'un segmento grande figura en cada bloque que cubre');

  // pool que ocupa todo: un solo segmento igual al pool
  const lleno = mapaBloques('192.168.0.0/28', [{ cidr: '192.168.0.0/28' }]);
  assert.equal(lleno.granularidad, 32);
  assert.equal(lleno.bloques.length, 16, 'pools pequeños: un bloque por dirección');
  assert.deepEqual(lleno.resumen, { libre: 0, parcial: 0, ocupado: 16 });

  // pool grande: /8 → bloques /16; un /12 cubre 16 bloques
  const grande = mapaBloques('10.0.0.0/8', [{ cidr: '10.64.0.0/12' }]);
  assert.equal(grande.granularidad, 16);
  assert.deepEqual(grande.resumen, { libre: 240, parcial: 0, ocupado: 16 });

  assert.deepEqual(mapaBloques('basura', []).bloques, []);
});

test('mapa de bloques: conserva la suma de direcciones (ocupado + parcial + libre = pool)', async () => {
  const { mapaBloques, tamanoCidr } = await cargar();
  const asigs = [{ cidr: '10.1.0.0/21' }, { cidr: '10.1.8.0/25' }, { cidr: '10.1.8.128/26' }, { cidr: '10.1.15.255/32' }];
  const m = mapaBloques('10.1.0.0/20', asigs);
  assert.equal(m.bloques.length, 256);
  assert.equal(m.resumen.libre + m.resumen.parcial + m.resumen.ocupado, 256);
  // bloques /28 (16 direcciones): el /21 cubre 128, el /25 cubre 8 y el /26 cubre 4; el /32 deja un bloque parcial
  assert.deepEqual(m.resumen, { libre: 256 - 141, parcial: 1, ocupado: 128 + 8 + 4 });
  assert.equal(tamanoCidr('10.1.0.0/21'), 2048);
});
