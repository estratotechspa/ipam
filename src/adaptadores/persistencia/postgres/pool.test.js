const test = require('node:test');
const assert = require('node:assert/strict');
const { resolverConexion, opcionesSsl, comillas } = require('./pool');

test('TLS con la semántica de libpq: disable / require (cifra sin verificar) / verify-full', () => {
  assert.deepEqual(opcionesSsl('disable'), false);
  assert.deepEqual(opcionesSsl('require'), { rejectUnauthorized: false });
  assert.deepEqual(opcionesSsl('verify-full', 'PEM'), { rejectUnauthorized: true, ca: 'PEM' });
  assert.equal(resolverConexion('postgres://u:p@h/d?sslmode=require').modo, 'require');
  assert.equal(resolverConexion('postgres://u:p@h/d?sslmode=verify-ca').modo, 'verify-full');
  assert.equal(resolverConexion('postgres://u:p@h/d').modo, 'disable');
  assert.equal(resolverConexion('postgres://u:p@h/d?sslmode=disable', 'require').modo, 'require', 'DATABASE_SSL manda sobre la URL');
  assert.throws(() => resolverConexion('postgres://u:p@h/d?sslmode=prefer'), /no soportado/);
});

test('se quitan de la URL los parámetros de TLS (los controla DATABASE_SSL) y se conservan los demás', () => {
  const { connectionString } = resolverConexion('postgres://u:p@h:5432/d?sslmode=require&application_name=x&sslrootcert=/tmp/x');
  assert.ok(!/ssl/.test(connectionString));
  assert.match(connectionString, /application_name=x/);
});

test('conexión por socket de Cloud SQL (?host=/cloudsql/…) y URL inválida', () => {
  const r = resolverConexion('postgres://ipam_app:clave@/ipam?host=/cloudsql/proy:region:inst');
  assert.match(r.connectionString, /host=%2Fcloudsql%2Fproy%3Aregion%3Ainst|host=\/cloudsql\/proy:region:inst/);
  assert.equal(r.modo, 'disable');
  assert.throws(() => resolverConexion('esto no es una url'), /DATABASE_URL/);
});

test('el nombre del esquema solo admite identificadores simples (no se puede inyectar SQL)', () => {
  assert.equal(comillas('ipam'), '"ipam"');
  for (const malo of ['ipam"; drop table x; --', 'Ipam', '1abc', 'a b', '']) assert.throws(() => comillas(malo), /DATABASE_SCHEMA/);
});
