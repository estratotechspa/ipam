// Firma del webhook de Jira con timestamp (función pura, sin base de datos).
const test = require('node:test');
const assert = require('node:assert/strict');
const { firmar, verificar, VENTANA_SEGUNDOS } = require('./adaptadores/http/firma-webhook');

const SECRETO = 'secreto-de-prueba-largo';
const AHORA = 1_800_000_000; // segundos
const cuerpo = Buffer.from('{"ticket":"NET-1","ambiente":"qa"}');
const cab = (ts, firma = firmar(SECRETO, String(ts), cuerpo)) => ({ 'x-ipam-timestamp': String(ts), 'x-hub-signature-256': firma });
const ver = (headers, { c = cuerpo, ahora = AHORA } = {}) => verificar({ secreto: SECRETO, headers, cuerpo: c, ahoraMs: ahora * 1000 });

test('una firma reciente y bien hecha es válida; la ventana es de 5 minutos', () => {
  assert.equal(VENTANA_SEGUNDOS, 300);
  assert.equal(ver(cab(AHORA)).ok, true);
  assert.equal(ver(cab(AHORA - 299)).ok, true);
  assert.equal(ver(cab(AHORA + 299)).ok, true);
  assert.equal(ver(cab(AHORA - 301)).ok, false);
  assert.equal(ver(cab(AHORA + 301)).ok, false);
  assert.match(ver(cab(AHORA - 3600)).motivo, /ventana de 5 minutos/);
});

test('exige el timestamp: sin él, o con un valor que no es número, se rechaza aunque la firma antigua (solo del cuerpo) fuera correcta', () => {
  const crypto = require('node:crypto');
  const antigua = 'sha256=' + crypto.createHmac('sha256', SECRETO).update(cuerpo).digest('hex');
  for (const h of [
    { 'x-hub-signature-256': antigua },
    { ...cab(AHORA), 'x-ipam-timestamp': '' },
    { ...cab(AHORA), 'x-ipam-timestamp': 'ayer' },
    { ...cab(AHORA), 'x-ipam-timestamp': '12' },
  ]) {
    const r = ver(h);
    assert.equal(r.ok, false);
    assert.match(r.motivo, /x-ipam-timestamp/);
  }
});

test('la firma cubre el timestamp y el cuerpo: cambiar cualquiera de los dos, o usar otro secreto, la invalida', () => {
  const r1 = ver(cab(AHORA, firmar(SECRETO, String(AHORA - 1), cuerpo)));
  assert.deepEqual([r1.ok, r1.motivo], [false, 'firma inválida']);
  assert.equal(ver(cab(AHORA), { c: Buffer.from('{"ticket":"NET-2"}') }).ok, false);
  assert.equal(ver(cab(AHORA, firmar('otro-secreto', String(AHORA), cuerpo))).ok, false);
  assert.equal(ver(cab(AHORA, 'sha256=00')).ok, false);
  assert.equal(ver(cab(AHORA, '')).ok, false);
  assert.notEqual(firmar(SECRETO, '1', cuerpo), firmar(SECRETO, '2', cuerpo));
});

test('tolera el timestamp en milisegundos', () => {
  const ms = String(AHORA * 1000);
  assert.equal(ver({ 'x-ipam-timestamp': ms, 'x-hub-signature-256': firmar(SECRETO, ms, cuerpo) }).ok, true);
});
