const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const T = require('./token');
const { generar, hashear } = require('../adaptadores/auth/token');

const ahora = new Date('2026-10-21T12:00:00Z');
const dias = (n) => new Date(ahora.getTime() + n * 86400_000);

test('un token generado cumple el formato (ipam_ + 43 base64url), es único y su hash es SHA-256 hexadecimal', () => {
  const vistos = new Set();
  for (let i = 0; i < 200; i++) {
    const { token, hash } = generar();
    assert.match(token, /^ipam_[A-Za-z0-9_-]{43}$/);
    assert.equal(token.length, 48);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(hash, hashear(token));
    assert.ok(!vistos.has(token));
    vistos.add(token);
  }
  assert.equal(T.prefijoDe('ipam_AbCdEfGh'), 'ipam_AbCd');
});

test('pareceToken rechaza lo que no tiene el formato', () => {
  assert.equal(T.pareceToken(generar().token), true);
  for (const m of [undefined, null, 5, '', 'ipam_corto', `ipam_${'a'.repeat(44)}`, `xxxx_${'a'.repeat(43)}`, `ipam_${'a'.repeat(42)}!`, ` ipam_${'a'.repeat(43)}`]) assert.equal(T.pareceToken(m), false, String(m));
});

test('validarCreacion: nombre, rol, vigencia (1 a 365, 90 por defecto) y cuota', () => {
  const cfg = { vidaDefectoDias: 90 };
  assert.deepEqual(T.validarCreacion({ nombre: 'agente-redes', rol: 'agente' }, cfg), { ok: true, nombre: 'agente-redes', rol: 'agente', dias: 90, cuota: null });
  assert.deepEqual(T.validarCreacion({ nombre: 'a1', rol: 'lector', expira_dias: 365, cuota_reservas: 5 }, cfg), { ok: true, nombre: 'a1', rol: 'lector', dias: 365, cuota: 5 });
  for (const n of ['A', 'a', '-ab', 'Agente', 'a b', 'a_b', 'x'.repeat(42), '', null, 7]) assert.equal(T.validarCreacion({ nombre: n, rol: 'agente' }, cfg).error, 'nombre_invalido', String(n));
  assert.equal(T.validarCreacion({ nombre: 'x'.repeat(41), rol: 'agente' }, cfg).ok, true);
  for (const r of ['admin', 'solicitante', '', undefined]) assert.equal(T.validarCreacion({ nombre: 'ok', rol: r }, cfg).error, 'rol_invalido');
  for (const d of [0, 366, -1, 1.5, 'x']) assert.equal(T.validarCreacion({ nombre: 'ok', rol: 'agente', expira_dias: d }, cfg).error, 'vigencia_invalida', String(d));
  for (const c of [0, -1, 1.5, 'x']) assert.equal(T.validarCreacion({ nombre: 'ok', rol: 'agente', cuota_reservas: c }, cfg).error, 'cuota_invalida', String(c));
});

test('propiedad: la vigencia aceptada siempre está entre 1 y 365 días', () => {
  fc.assert(fc.property(fc.integer({ min: -50, max: 800 }), (n) => {
    const r = T.validarCreacion({ nombre: 'ok', rol: 'lector', expira_dias: n }, { vidaDefectoDias: 90 });
    return r.ok ? r.dias === n && n >= 1 && n <= 365 : (n < 1 || n > 365);
  }));
});

test('estado y vencimiento próximo', () => {
  assert.equal(T.estadoToken({ expira_en: dias(10) }, ahora), 'activo');
  assert.equal(T.estadoToken({ expira_en: dias(-1) }, ahora), 'vencido');
  assert.equal(T.estadoToken({ expira_en: dias(10), revocado_en: ahora }, ahora), 'revocado');
  assert.equal(T.estadoToken({ expira_en: dias(-1), revocado_en: ahora }, ahora), 'revocado', 'revocado manda sobre vencido');
  assert.equal(T.porVencer({ expira_en: dias(6) }, ahora), true);
  assert.equal(T.porVencer({ expira_en: dias(7) }, ahora), false);
  assert.equal(T.porVencer({ expira_en: dias(-1) }, ahora), false, 'un vencido ya no «está por vencer»');
  assert.equal(T.porVencer({ expira_en: dias(3), revocado_en: ahora }, ahora), false);
});
