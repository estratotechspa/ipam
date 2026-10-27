const test = require('node:test');
const assert = require('node:assert/strict');
const { rolVigente, resolverRol, tiene } = require('./roles');

const CFG = {
  correosAdmin: ['jefe@empresa.cl'],
  correosSolicitante: [],
  correosLector: [],
  claimGrupos: 'groups',
  gruposAdmin: [],
  gruposSolicitante: [],
  gruposLector: [],
  rolPorDefecto: 'lector',
};

test('rolVigente: la baja o la eliminación cortan la sesión; el rol de la base manda sobre el base; los admin de la configuración siempre entran', () => {
  const cfg = { correosAdmin: ['jefe@empresa.cl'] };
  const ses = (email, rolBase) => ({ email, rolBase });
  assert.equal(rolVigente(ses('a@x.cl', 'lector'), { rol: null, activo: true }, cfg), 'lector', 'sin rol en la base: el rol base');
  assert.equal(rolVigente(ses('a@x.cl', 'lector'), { rol: 'admin', activo: true }, cfg), 'admin', 'ascenso desde la base');
  assert.equal(rolVigente(ses('a@x.cl', 'admin'), { rol: 'lector', activo: true }, cfg), 'lector', 'degradación desde la base');
  assert.equal(rolVigente(ses('a@x.cl', 'admin'), { rol: 'lector', activo: false }, cfg), null, 'dado de baja');
  assert.equal(rolVigente(ses('a@x.cl', 'admin'), null, cfg), null, 'eliminado');
  assert.equal(rolVigente(ses('a@x.cl', null), { rol: null, activo: true }, cfg), null, 'sin rol base ni rol asignado');
  assert.equal(rolVigente(ses('a@x.cl', 'dios'), { rol: null, activo: true }, cfg), null, 'rol inválido');
  assert.equal(rolVigente(ses('JEFE@empresa.cl', 'lector'), null, cfg), 'admin', 'correo admin de la configuración, aunque no exista en la base');
  assert.equal(rolVigente(ses('jefe@empresa.cl', 'lector'), { rol: 'lector', activo: false }, cfg), 'admin', 'ni dado de baja pierde el acceso de emergencia');
});

test('el rol base que se guarda en la cookie no incluye la asignación de la base (se aplica al revalidar)', () => {
  const claims = { email: 'ana@empresa.cl', groups: ['ipam-solicitantes'] };
  const cfg = { ...CFG, gruposSolicitante: ['ipam-solicitantes'] };
  assert.equal(resolverRol(claims, null, cfg), 'solicitante');
  // con la asignación de la base, el login ve otro rol; el rol base de la cookie sigue siendo el del proveedor
  assert.equal(resolverRol(claims, { rol: 'admin', activo: true }, cfg), 'admin');
  assert.equal(
    rolVigente({ email: claims.email, rolBase: resolverRol(claims, null, cfg) }, { rol: null, activo: true }, cfg),
    'solicitante',
    '«heredar» vuelve al del proveedor',
  );
  assert.equal(tiene('admin', 'solicitante'), true);
});
