// Verificaciones de calidad y seguridad del código que no son «una prueba de comportamiento» pero SÍ deben fallar si alguien las rompe:
// la regla de lint contra SQL armado con texto, y que el código del proyecto cumple las reglas.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ESLint } = require('eslint');

const eslint = new ESLint({ cwd: path.join(__dirname, '..') });
const archivo = path.join(__dirname, 'adaptadores', 'persistencia', 'postgres', 'virtual.js');
const lint = async (codigo) => (await eslint.lintText(codigo, { filePath: archivo }))[0].messages;
const reglaSql = (mensajes) => mensajes.filter((m) => m.ruleId === 'no-restricted-syntax' && /SQL/.test(m.message));

test('lint de SQL: falla si se arma una consulta con texto (plantilla con variables, concatenación, concat/replace/join)', async () => {
  const malos = {
    'plantilla con una variable': 'async function f(db, id) { return db.query(`select * from t where id = ${id}`); }',
    'plantilla con una llamada': 'async function f(db, x) { return db.query(`select * from ${x.tabla()}`); }',
    concatenación: "async function f(db, id) { return db.query('select * from t where id = ' + id); }",
    concat: "async function f(db, id) { return db.query('select * from t where id = '.concat(id)); }",
    replace: "async function f(db, id) { return db.query('select * from t where id = :id'.replace(':id', id)); }",
    join: "async function f(db, ids) { return db.query(['select * from t where id in (', ids.join(','), ')'].join('')); }",
    'el alias q del repositorio': 'const q = (t, p) => p; async function f(id) { return q(`delete from t where id = ${id}`, []); }',
    'consultar (transacción)': 'async function f(tx, id) { return tx.consultar(`select ${id}`); }',
  };
  for (const [nombre, codigo] of Object.entries(malos)) {
    assert.ok(reglaSql(await lint(codigo)).length >= 1, `la regla NO detectó: ${nombre}`);
  }
});

test('lint de SQL: se permiten consultas parametrizadas y fragmentos fijos (constantes en MAYÚSCULAS del módulo)', async () => {
  const buenos = [
    "async function f(db, id) { return db.query('select * from t where id = $1', [id]); }",
    'const COLUMNAS = "a, b";\nasync function f(db, id) { return db.query(`select ${COLUMNAS} from t where id = $1`, [id]); }',
    'const SQL_UNO = "select 1";\nasync function f(db) { return db.query(SQL_UNO); }',
    "async function f(db, id) { return db.query(id ? SQL_A : SQL_B, [id]); }\nconst SQL_A = 'select 1', SQL_B = 'select 2';",
  ];
  for (const codigo of buenos) assert.equal(reglaSql(await lint(codigo)).length, 0, codigo);
});

test('el código de producción no lee process.env fuera de config, no usa console ni eval', async () => {
  const mal = await lint('const x = process.env.ALGO; console.log(x); eval("1");');
  const reglas = new Set(mal.map((m) => m.ruleId));
  for (const r of ['no-restricted-properties', 'no-console', 'no-eval']) assert.ok(reglas.has(r), `falta detectar ${r}`);
});

test('el proyecto cumple las reglas de lint (src/, scripts y configuración)', async () => {
  const resultados = await eslint.lintFiles(['src', 'public', 'scripts', 'eslint.config.js']);
  const problemas = resultados.flatMap((r) =>
    r.messages.filter((m) => m.severity === 2).map((m) => `${path.relative(process.cwd(), r.filePath)}:${m.line} ${m.ruleId} ${m.message}`),
  );
  assert.deepEqual(problemas, []);
});
