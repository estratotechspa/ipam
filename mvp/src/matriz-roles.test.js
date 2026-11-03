// Matriz de roles: cada ruta de /api/v1 declara el rol mínimo que exige. Una ruta nueva sin entrada aquí rompe la prueba (se niega por defecto),
// y un token con un rol menor al de la matriz debe recibir 403 en cada ruta. Se prueba por HTTP, con tokens reales.
const test = require('node:test');
const assert = require('node:assert/strict');
const { hayBase, crearBaseAislada, lanzarServicio } = require('./pruebas/ayudas');
const { grupoDe } = require('./dominio/alcance');

const opts = { skip: hayBase ? false : 'sin DATABASE_URL' };
const ADM = { 'X-Requested-With': 'ipam', 'Content-Type': 'application/json' };
const NIVEL = { lector: 0, agente: 1, solicitante: 2, admin: 3 };

// «lector» = cualquier persona o token autenticado.
const MATRIZ = {
  'GET /api/v1/pools': 'lector',
  'POST /api/v1/pools': 'admin',
  'PATCH /api/v1/pools/{id}': 'admin',
  'DELETE /api/v1/pools/{id}': 'admin',
  'GET /api/v1/pools/{id}/libres': 'lector',
  'GET /api/v1/pools/{id}/disponibilidad': 'lector',
  'GET /api/v1/resumen': 'lector',
  'GET /api/v1/asignaciones': 'lector',
  'POST /api/v1/solicitudes': 'admin',
  'DELETE /api/v1/asignaciones/{id}': 'admin',
  'POST /api/v1/importaciones/simular': 'admin',
  'POST /api/v1/importaciones/aplicar': 'admin',
  'POST /api/v1/importar': 'admin',
  'GET /api/v1/exportar.xlsx': 'lector',
  'GET /api/v1/exportar.json': 'admin',
  'GET /api/v1/reservas': 'lector',
  'POST /api/v1/reservas': 'agente',
  'GET /api/v1/reservas/{id}': 'lector',
  'DELETE /api/v1/reservas/{id}': 'agente',
  'POST /api/v1/reservas/{id}/confirmar': 'admin',
  'GET /api/v1/direcciones': 'lector',
  'POST /api/v1/direcciones': 'agente',
  'PATCH /api/v1/direcciones/{id}': 'agente',
  'DELETE /api/v1/direcciones/{id}': 'admin',
  'GET /api/v1/tokens': 'admin',
  'POST /api/v1/tokens': 'admin',
  'DELETE /api/v1/tokens/{id}': 'admin',
  'GET /api/v1/usuarios': 'admin',
  'POST /api/v1/usuarios': 'admin',
  'PUT /api/v1/usuarios/{email}': 'admin',
  'DELETE /api/v1/usuarios/{email}': 'admin',
  'POST /api/v1/usuarios/{email}/desactivar': 'admin',
  'POST /api/v1/usuarios/{email}/activar': 'admin',
  'POST /api/v1/usuarios/{email}/restablecer-clave': 'admin',
  'POST /api/v1/yo/clave': 'lector',
  'GET /api/v1/auditoria': 'admin',
  'GET /api/v1/eventos': 'admin',
  'GET /api/v1/jira/estado': 'lector',
  'POST /api/v1/jira/simular': 'solicitante',
  'GET /api/v1/me': 'lector',
  'GET /api/v1/openapi.json': 'lector',
};

let b, s;
test.before(async () => {
  if (!hayBase) return;
  b = await crearBaseAislada();
  s = await lanzarServicio({ DATABASE_URL: b.url, RATE_LIMIT_POR_MINUTO: '5000', RATE_LIMIT_ESCRITURA_POR_MINUTO: '5000', RATE_LIMIT_IP_POR_MINUTO: '50000' });
});
test.after(async () => {
  if (!hayBase) return;
  await s.parar();
  await b.borrar();
});

const llamar = (metodo, ruta, cabeceras, cuerpo) =>
  fetch(s.url + ruta, { method: metodo, headers: cabeceras, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
const crearToken = async (rol) => {
  const r = await llamar('POST', '/api/v1/tokens', ADM, { nombre: `matriz-${rol}`, rol });
  assert.equal(r.status, 201);
  return (await r.json()).token;
};

test('la matriz cubre exactamente las rutas del contrato (una ruta nueva debe declarar su rol)', opts, async () => {
  const contrato = await (await llamar('GET', '/api/v1/openapi.json', ADM)).json();
  const reales = new Set();
  for (const [camino, ops] of Object.entries(contrato.paths))
    if (camino.startsWith('/api/v1/'))
      for (const m of Object.keys(ops)) if (['get', 'post', 'put', 'patch', 'delete'].includes(m)) reales.add(`${m.toUpperCase()} ${camino}`);
  assert.deepEqual([...reales].filter((r) => !(r in MATRIZ)).sort(), [], 'rutas sin rol declarado en la matriz');
  assert.deepEqual(
    Object.keys(MATRIZ)
      .filter((r) => !reales.has(r))
      .sort(),
    [],
    'entradas de la matriz que ya no existen',
  );
});

test('un token con rol menor al exigido recibe 403 en cada ruta (y nunca 403 por rol en las de lector)', opts, async () => {
  const tokens = { lector: await crearToken('lector'), agente: await crearToken('agente') };
  const fallos = [];
  for (const [clave, minimo] of Object.entries(MATRIZ)) {
    const [metodo, plantilla] = clave.split(' ');
    const camino = plantilla.replace(/\{[^}]+\}/g, 'x');
    for (const [rol, token] of Object.entries(tokens)) {
      if (NIVEL[rol] >= NIVEL[minimo]) continue; // con rol suficiente no se llama: evita efectos reales
      const r = await llamar(
        metodo,
        camino,
        { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ['GET', 'DELETE'].includes(metodo) ? undefined : {},
      );
      if (r.status !== 403) fallos.push(`${clave} como ${rol}: ${r.status} (esperaba 403)`);
    }
  }
  assert.deepEqual(fallos, []);
});

test('toda ruta de lector o agente está en un grupo de alcance (o es siempre permitida); las de solicitante y admin, en ninguno', () => {
  const sinGrupo = [];
  for (const [clave, minimo] of Object.entries(MATRIZ)) {
    const [metodo, plantilla] = clave.split(' ');
    const g = grupoDe(metodo, plantilla.replace(/\{[^}]+\}/g, 'x'));
    if (NIVEL[minimo] <= NIVEL.agente && !['GET /api/v1/jira/estado', 'GET /api/v1/exportar.xlsx', 'POST /api/v1/yo/clave'].includes(clave) && g === undefined)
      sinGrupo.push(clave);
    if (NIVEL[minimo] > NIVEL.agente && g !== undefined) sinGrupo.push(`${clave} (admin/solicitante no debe estar en un grupo)`);
  }
  assert.deepEqual(sinGrupo, [], 'rutas de lector/agente sin grupo de alcance (decide a cuál pertenecen en dominio/alcance.js)');
});
