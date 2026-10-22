// El contrato OpenAPI es válido, está completo (rutas de Express ↔ contrato, en los dos sentidos) y sus ejemplos cumplen sus esquemas.
// No necesita base de datos: la aplicación se construye sin conectarse.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://nadie:nada@127.0.0.1:1/ninguna';
const { Validator } = require('@seriousme/openapi-schema-validator');
const { construirOpenApi, schemas } = require('./openapi');
const { listarRutas } = require('./adaptadores/http/registro');
const { crearValidador, traducir } = require('./adaptadores/http/validacion');

const doc = construirOpenApi();
const METODOS = ['get', 'post', 'put', 'delete', 'patch'];
const aOpenApi = (camino) => camino.replace(/:([A-Za-z_]+)/g, '{$1}');

/** Todas las rutas del contrato, incluidos los alias históricos. */
function rutasDelContrato() {
  const s = new Set();
  for (const [camino, item] of Object.entries(doc.paths)) {
    for (const m of METODOS.filter((x) => item[x])) {
      s.add(`${m.toUpperCase()} ${camino}`);
      if (item['x-alias-legado']) s.add(`${m.toUpperCase()} ${item['x-alias-legado']}`);
    }
  }
  return s;
}

test('el documento es un OpenAPI 3.1 válido', async () => {
  const r = await new Validator().validate(JSON.parse(JSON.stringify(doc)));
  assert.equal(r.valid, true, JSON.stringify(r.errors, null, 1));
  assert.equal(doc.openapi, '3.1.0');
  assert.ok(doc.info.version && doc.info.title);
});

test('paridad: cada ruta registrada en Express existe en el contrato y cada ruta del contrato existe en Express', () => {
  const { app } = require('./server');
  const express = new Set(listarRutas(app).map((r) => `${r.metodo} ${aOpenApi(r.camino)}`));
  const contrato = rutasDelContrato();
  const sobranEnContrato = [...contrato].filter((r) => !express.has(r));
  const faltanEnContrato = [...express].filter((r) => !contrato.has(r));
  assert.deepEqual(faltanEnContrato, [], `Rutas de Express SIN documentar en el contrato:\n${faltanEnContrato.join('\n')}`);
  assert.deepEqual(sobranEnContrato, [], `Rutas del contrato que NO existen en Express:\n${sobranEnContrato.join('\n')}`);
  assert.ok(express.size >= 50);
});

test('todas las referencias ($ref) del contrato se resuelven', () => {
  const faltan = [];
  const caminar = (n, ruta) => {
    if (Array.isArray(n)) return n.forEach((x, i) => caminar(x, `${ruta}/${i}`));
    if (n && typeof n === 'object') {
      if (typeof n.$ref === 'string') {
        const partes = n.$ref.replace(/^#\//, '').split('/');
        let cur = doc;
        for (const p of partes) cur = cur && cur[p.replace(/~1/g, '/').replace(/~0/g, '~')];
        if (cur === undefined) faltan.push(`${ruta} → ${n.$ref}`);
      }
      for (const [k, v] of Object.entries(n)) caminar(v, `${ruta}/${k}`);
    }
  };
  caminar(doc, '');
  assert.deepEqual(faltan, []);
});

test('cada operación documenta resumen, etiqueta y respuestas; las protegidas documentan el 401; los operationId son únicos', () => {
  const ids = new Set();
  for (const [camino, item] of Object.entries(doc.paths)) {
    if (item['x-alias-legado']) assert.match(item['x-alias-legado'], /^\/api\/(?!v1)/, `${camino}: alias inválido`);
    for (const m of METODOS.filter((x) => item[x])) {
      const o = item[m];
      const nombre = `${m.toUpperCase()} ${camino}`;
      assert.ok(o.summary && o.summary.length > 5, `${nombre}: sin resumen`);
      assert.ok(o.tags && o.tags.length, `${nombre}: sin etiqueta`);
      assert.ok(Object.keys(o.responses).length >= 1, `${nombre}: sin respuestas`);
      if (o.security && o.security.length) assert.ok(o.responses[401], `${nombre}: protegida pero sin 401 documentado`);
      if (o.operationId) { assert.ok(!ids.has(o.operationId), `operationId repetido ${o.operationId}`); ids.add(o.operationId); }
    }
  }
  // Los endpoints de agentes están documentados con sus errores clave.
  const post = doc.paths['/api/v1/reservas'].post.responses;
  for (const c of ['200', '201', '400', '401', '403', '404', '409', '422', '429']) assert.ok(post[c], `reservar sin ${c}`);
  assert.ok(doc.paths['/api/v1/reservas/{id}/confirmar'].post.responses['409']);
});

test('los ejemplos de cada esquema cumplen su propio esquema', () => {
  const v = crearValidador(doc);
  for (const [nombre, esquema] of Object.entries(schemas)) {
    if (esquema.example === undefined) continue;
    const r = v.validar(nombre, esquema.example);
    assert.equal(r.ok, true, `El ejemplo de «${nombre}» no cumple su esquema: ${JSON.stringify(r.errores)}`);
  }
});

test('los ejemplos de peticiones y respuestas en cada operación cumplen el esquema de su contenido', () => {
  const v = crearValidador(doc);
  let revisados = 0;
  for (const [camino, item] of Object.entries(doc.paths)) {
    for (const m of METODOS.filter((x) => item[x])) {
      const o = item[m];
      const contenidos = [];
      if (o.requestBody) contenidos.push(['petición', o.requestBody.content, `/paths/${camino.replace(/\//g, '~1')}/${m}/requestBody`]);
      for (const [estado, r] of Object.entries(o.responses)) if (r.content) contenidos.push([`respuesta ${estado}`, r.content, `/paths/${camino.replace(/\//g, '~1')}/${m}/responses/${estado}`]);
      for (const [que, content, base] of contenidos) {
        const mt = content['application/json'];
        if (!mt || mt.example === undefined) continue;
        const validar = v.ajv.compile({ $ref: `openapi#${base}/content/application~1json/schema` });
        assert.equal(validar(mt.example), true, `${m.toUpperCase()} ${camino} (${que}): ejemplo inválido ${JSON.stringify(validar.errors)}`);
        revisados += 1;
      }
    }
  }
  assert.ok(revisados >= 10, `solo se revisaron ${revisados} ejemplos`);
});

test('la validación de entrada sale del contrato: campos faltantes, desconocidos y de tipo equivocado se rechazan con mensajes en español', () => {
  const v = crearValidador(doc);
  assert.equal(v.validar('ReservaCrear', { vpc: 'v', mascara: 24, ambiente: 'qa', tipo: 'Nodos' }).ok, true);
  const falta = v.validar('ReservaCrear', { mascara: 24 });
  assert.deepEqual(falta.errores, [{ campo: '/vpc', mensaje: 'es obligatorio' }]);
  const extra = v.validar('ReservaCrear', { vpc: 'v', mascar: 24 });
  assert.deepEqual(extra.errores, [{ campo: '/mascar', mensaje: 'campo no permitido' }]);
  assert.deepEqual(v.validar('ReservaCrear', { vpc: 5 }).errores, [{ campo: '/vpc', mensaje: 'debe ser texto' }]);
  assert.deepEqual(v.validar('ReservaCrear', { vpc: 'v', ambiente: 'staging' }).errores[0].mensaje, 'debe ser uno de: dev, qa, pre, prod');
  assert.match(v.validar('TokenCrear', { nombre: 'Mal Nombre', rol: 'agente' }).errores[0].mensaje, /formato/);
  assert.equal(v.validar('TokenCrear', { nombre: 'ok-1', rol: 'admin' }).ok, false);
  assert.equal(v.validar('ReservaCrear', []).ok, false, 'un arreglo no es un objeto');
  assert.deepEqual(traducir({ keyword: 'minimum', instancePath: '/x', params: { limit: 3 } }), { campo: '/x', mensaje: 'debe ser al menos 3' });
  assert.throws(() => v.cuerpo('NoExiste'), /no define el esquema/);
});
