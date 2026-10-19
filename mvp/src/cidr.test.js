const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, overlap, libres } = require('./cidr');

test('parse valida formato y alineación', () => {
  assert.equal(parse('10.64.8.0/22').aligned, true);
  assert.equal(parse('10.64.9.0/22').aligned, false);
  assert.equal(parse('10.64.8.0/33'), null);
  assert.equal(parse('300.1.1.1/24'), null);
  assert.equal(parse('hola'), null);
});
test('overlap detecta contención y cruce', () => {
  assert.equal(overlap(parse('10.64.8.0/22'), parse('10.64.8.0/21')), true);
  assert.equal(overlap(parse('10.64.16.0/22'), parse('10.64.8.0/21')), false);
});
test('libres respeta ocupados y alineación (caso del mockup)', () => {
  const ocup = ['10.64.0.0/21', '10.64.8.0/21', '10.64.32.0/19'];
  assert.deepEqual(libres('10.64.0.0/12', ocup, 22, 3), ['10.64.16.0/22', '10.64.20.0/22', '10.64.24.0/22']);
});
test('libres en pool lleno devuelve vacío', () => {
  assert.deepEqual(libres('10.0.0.0/30', ['10.0.0.0/30'], 30), []);
  assert.deepEqual(libres('10.0.0.0/24', [], 16), []);
});
