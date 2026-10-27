// Pruebas del cálculo de CIDR: ejemplos y propiedades (fast-check) con comparación contra una versión «de fuerza bruta».
const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const { parse, overlap, libres, disponibilidad, n2ip, ip2n, contenido, aTexto, tamano } = require('./cidr');

// Generadores: un bloque alineado cualquiera (/8 a /32) y un pool pequeño donde la fuerza bruta es viable.
const bloqueAlineado = fc
  .integer({ min: 8, max: 32 })
  .chain((len) => fc.integer({ min: 0, max: 2 ** len - 1 }).map((i) => `${n2ip(i * 2 ** (32 - len))}/${len}`));
const POOL = '10.210.0.0/24';
const bloquesDelPool = fc
  .integer({ min: 24, max: 30 })
  .chain((len) => fc.integer({ min: 0, max: 2 ** (len - 24) - 1 }).map((i) => `${n2ip(ip2n('10.210.0.0') + i * 2 ** (32 - len))}/${len}`));

test('ejemplos: parse valida formato y alineación; tamaño; texto', () => {
  assert.equal(parse('10.64.8.0/22').aligned, true);
  assert.equal(parse('10.64.9.0/22').aligned, false);
  assert.equal(parse('10.64.8.0/33'), null);
  assert.equal(parse('300.1.1.1/24'), null);
  assert.equal(parse('10.1.1.1'), null);
  assert.equal(parse(undefined), null);
  assert.equal(tamano('10.0.0.0/24'), 256);
  assert.equal(aTexto(parse('10.210.4.0/22')), '10.210.4.0/22');
  assert.equal(ip2n('1.2.3'), null);
  assert.equal(ip2n('1.2.3.256'), null);
  assert.equal(n2ip(ip2n('192.168.10.5')), '192.168.10.5');
});

test('propiedad: aTexto(parse(x)) = x para cualquier bloque alineado', () => {
  fc.assert(
    fc.property(bloqueAlineado, (b) => {
      const c = parse(b);
      return c.aligned && aTexto(c) === b && c.size === tamano(b);
    }),
  );
});

test('propiedad: overlap es simétrico y reflexivo; contenido implica solape; dos bloques alineados o se contienen o no se tocan', () => {
  fc.assert(
    fc.property(bloqueAlineado, bloqueAlineado, (x, y) => {
      const a = parse(x),
        b = parse(y);
      if (overlap(a, b) !== overlap(b, a) || !overlap(a, a)) return false;
      if (contenido(a, b) && !overlap(a, b)) return false;
      return !overlap(a, b) || contenido(a, b) || contenido(b, a);
    }),
    { numRuns: 500 },
  );
});

/** Fuerza bruta: todos los bloques /len alineados del pool que no tocan ningún ocupado. */
function libresBruta(pool, ocupados, len) {
  const p = parse(pool),
    out = [];
  for (let ip = p.start; ip + 2 ** (32 - len) - 1 <= p.end; ip += 2 ** (32 - len)) {
    const b = parse(`${n2ip(ip)}/${len}`);
    if (!ocupados.some((o) => overlap(b, parse(o)))) out.push(aTexto(b));
  }
  return out;
}

test('propiedad: libres() devuelve bloques alineados, dentro del pool, sin tocar lo ocupado ni entre sí, y los PRIMEROS posibles (igual que la fuerza bruta)', () => {
  fc.assert(
    fc.property(fc.array(bloquesDelPool, { maxLength: 12 }), fc.integer({ min: 24, max: 30 }), fc.integer({ min: 1, max: 6 }), (ocupados, len, max) => {
      const r = libres(POOL, ocupados, len, max);
      const pool = parse(POOL);
      for (const x of r) {
        const c = parse(x);
        if (!c || !c.aligned || c.len !== len || !contenido(c, pool)) return false;
        if (ocupados.some((o) => overlap(c, parse(o)))) return false;
      }
      for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) if (overlap(parse(r[i]), parse(r[j]))) return false;
      assert.deepEqual(r, libresBruta(POOL, ocupados, len).slice(0, max)); // son exactamente los primeros libres
      return true;
    }),
    { numRuns: 400 },
  );
});

test('libres: casos límite (pool lleno, máscara fuera de rango, ocupados mal formados)', () => {
  assert.deepEqual(libres('10.0.0.0/30', ['10.0.0.0/30'], 30), []);
  assert.deepEqual(libres('10.0.0.0/24', [], 16), []);
  assert.deepEqual(libres('10.0.0.0/24', [], 33), []);
  assert.deepEqual(libres('no-es-cidr', [], 24), []);
  assert.deepEqual(libres('10.0.0.0/24', ['basura', '10.0.0.0/25'], 25), ['10.0.0.128/25']);
  assert.deepEqual(libres('10.64.0.0/12', ['10.64.0.0/21', '10.64.8.0/21', '10.64.32.0/19'], 22, 3), ['10.64.16.0/22', '10.64.20.0/22', '10.64.24.0/22']);
});

test('disponibilidad: bloques libres por máscara, con direcciones totales y utilizables', () => {
  // Pool /24 (256 direcciones) con un /26 ocupado al comienzo: quedan 192 direcciones.
  const d = disponibilidad('10.210.0.0/24', ['10.210.0.0/26']);
  assert.deepEqual([d.total, d.ocupadas, d.libres], [256, 64, 192]);
  const por = Object.fromEntries(d.por_mascara.map((x) => [x.mascara, x]));
  assert.deepEqual(por[24], { mascara: 24, direcciones: 256, utilizables: 254, bloques_libres: 0, direcciones_libres: 0 });
  assert.equal(por[25].bloques_libres, 1); // 10.210.0.128/25
  assert.equal(por[26].bloques_libres, 3);
  assert.equal(por[28].bloques_libres, 12);
  assert.deepEqual([por[30].utilizables, por[31].utilizables, por[32].utilizables], [2, 2, 1]);
  assert.equal(disponibilidad('10.210.0.0/24', []).por_mascara[0].bloques_libres, 1);
  assert.equal(disponibilidad('hola', []).total, 0);
});

test('propiedad: disponibilidad concuerda con libres() y con la fuerza bruta, y lo libre nunca excede el pool', () => {
  fc.assert(
    fc.property(bloquesDelPool, fc.integer({ min: 24, max: 32 }), (ocupadosGen, len) => {
      const ocupados = Array.isArray(ocupadosGen) ? ocupadosGen : [ocupadosGen];
      const d = disponibilidad(POOL, ocupados);
      const fila = d.por_mascara.find((x) => x.mascara === len);
      assert.equal(fila.bloques_libres, libres(POOL, ocupados, len, Infinity).length);
      assert.equal(d.ocupadas + d.libres, d.total);
      for (const x of d.por_mascara) assert.ok(x.direcciones_libres <= d.libres);
    }),
  );
});
