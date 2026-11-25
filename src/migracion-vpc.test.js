// Migración de las asignaciones de un pool grande a pools hijos por VPC (`npm run migrar-vpc`): el plan (puro) y el CLI contra PostgreSQL real.
// Datos FICTICIOS con la forma del caso real: un pool de ambiente con cinco VPC repartidas en cuatro proyectos.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { planificar, bloqueCubriente, sugerirNombre } = require('./dominio/migracion-vpc');
const { parse } = require('./dominio/cidr');
const { hayBase, crearBaseAislada, RAIZ } = require('./pruebas/ayudas');

const opts = { skip: hayBase ? false : 'sin DATABASE_URL' };
const CLI = path.join(RAIZ, 'src', 'cli', 'migrar-vpc.js');
const PADRE = { id: 'dev-gcp-ccla', cidr: '10.200.0.0/16' };
const fila = (id, cidr, vpc, proyecto) => ({ id, cidr, vpc, proyecto });

test('plan: bloque más chico que cubre a cada VPC, id del pool, sin problemas', () => {
  assert.equal(String(bloqueCubriente([parse('10.0.0.0/24'), parse('10.0.3.0/24')])?.len), '22');
  const p = planificar({
    padre: PADRE,
    asignaciones: [fila(1, '10.200.0.0/24', 'vpc-a', 'hub-1'), fila(2, '10.200.3.0/24', 'VPC-A', 'hub-1'), fila(3, '10.200.16.0/22', 'vpc-b', 'hub-2')],
    idsEnUso: ['dev-gcp-ccla'],
  });
  assert.equal(p.ok, true, JSON.stringify(p.problemas));
  assert.deepEqual(
    p.grupos.map((g) => [g.vpc, g.proyecto, g.cidr, g.pool_id, g.asignaciones]),
    [
      ['vpc-a', 'hub-1', '10.200.0.0/22', 'vpc-a', 2],
      ['vpc-b', 'hub-2', '10.200.16.0/22', 'vpc-b', 1],
    ],
  );
});

test('plan: marca lo que una persona debe resolver (nombre, proyecto, bloques que se pisan o tapan ajenas, reservas)', () => {
  const p = planificar({
    padre: PADRE,
    asignaciones: [
      fila(1, '10.200.0.0/24', 'Mi VPC', 'hub-1'),
      fila(2, '10.200.1.0/24', 'vpc-c', 'hub-1'),
      fila(3, '10.200.1.0/24'.replace('1.0', '2.0'), 'vpc-c', 'hub-9'), // dos proyectos
      fila(4, '10.200.4.0/24', 'vpc-d', null), // sin proyecto
      fila(5, '10.200.0.0/22'.replace('0/22', '8.0/24'), 'vpc-e', 'hub-1'),
      fila(6, '10.200.0.0/22'.replace('0.0/22', '9.0/24'), 'vpc-f', 'hub-1'),
      fila(7, '10.200.8.128/25'.replace('8.128/25', '10.0/24'), '', null), // sin VPC dentro del bloque de vpc-e si se ensancha
    ],
    reservasVigentes: [{ cidr: '10.200.9.0/25' }],
  });
  const tipos = p.problemas.map((x) => x.tipo);
  for (const t of ['vpc_invalido', 'vpc_incoherente', 'sin_proyecto', 'reserva_vigente_en_bloque'])
    assert.ok(tipos.includes(t), `falta ${t}: ${JSON.stringify(tipos)}`);
  assert.equal(p.ok, false);
  assert.match(p.problemas.find((x) => x.tipo === 'vpc_invalido').detalle, /mi-vpc/);
  assert.equal(p.avisos[0].tipo, 'sin_vpc');
  // Un ajuste resuelve lo que la persona decide: el proyecto y el bloque.
  const ok = planificar({
    padre: PADRE,
    asignaciones: [fila(2, '10.200.1.0/24', 'vpc-c', 'hub-1'), fila(3, '10.200.2.0/24', 'vpc-c', 'hub-9')],
    ajustes: [{ vpc: 'vpc-c', proyecto: 'hub-1', cidr: '10.200.0.0/22', id: 'vpc-c-dev' }],
  });
  assert.equal(ok.ok, true, JSON.stringify(ok.problemas));
  assert.deepEqual([ok.grupos[0].pool_id, ok.grupos[0].cidr], ['vpc-c-dev', '10.200.0.0/22']);
  assert.equal(sugerirNombre(' Mi_VPC 1 '), 'mi-vpc-1');
});

const migrar = (url, args, ajustes) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-vpc-'));
  const extra = [];
  if (ajustes) {
    fs.writeFileSync(path.join(dir, 'ajustes.json'), JSON.stringify(ajustes));
    extra.push('--ajustes', path.join(dir, 'ajustes.json'));
  }
  const salida = path.join(dir, 'plan.json');
  const r = spawnSync(process.execPath, [CLI, '--pool', 'dev-gcp-ccla', '--salida', salida, ...extra, ...args], {
    env: { PATH: process.env.PATH, DATABASE_URL: url },
    encoding: 'utf8',
  });
  r.plan = fs.existsSync(salida) ? JSON.parse(fs.readFileSync(salida, 'utf8')) : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
};

test('CLI: simula sin escribir; aplica todo o nada; las IP fijas siguen a su segmento; el padre queda sin lo repartido', opts, async () => {
  const b = await crearBaseAislada();
  try {
    await b.sql(
      "insert into pools (id,tipo,ambiente,proveedor,cidr,mascara_defecto,mascara_minima,mascara_maxima) values ('dev-gcp-ccla','Nodos','dev','GCP','10.200.0.0/16',24,20,28)",
    );
    const vpcs = [
      ['vpc-hub', 'hub-uno', '10.200.0.0/24'],
      ['vpc-hub', 'hub-uno', '10.200.2.0/24'],
      ['vpc-datos', 'hub-dos', '10.200.16.0/22'],
      ['vpc-web', 'hub-tres', '10.200.32.0/24'],
      ['vpc-api', 'hub-tres', '10.200.48.0/24'],
      ['vpc-lab', 'hub-cuatro', '10.200.64.0/24'],
    ];
    for (const [i, [vpc, proyecto, cidr]] of vpcs.entries())
      await b.sql("insert into asignaciones (pool_id,cidr,vpc,proyecto,solicitante,ticket) values ('dev-gcp-ccla',$1,$2,$3,'migracion','NET-' || $4::text)", [
        cidr,
        vpc,
        proyecto,
        i + 1,
      ]);
    await b.sql(
      "insert into direcciones_ip (ip, asignacion_id, dispositivo, creado_por) select '10.200.16.1', id, 'fw', 'prueba' from asignaciones where vpc = 'vpc-datos'",
    );

    const sim = migrar(b.url, []);
    assert.equal(sim.status, 0, sim.stderr);
    const plan = sim.plan;
    assert.equal(plan.ok, true, JSON.stringify(plan.problemas));
    assert.equal(plan.grupos.length, 5);
    assert.equal((await b.sql('select count(*)::int as n from pools where padre_id is not null')).rows[0].n, 0, 'simular no escribe nada');

    // Con un problema no se aplica nada.
    await b.sql("update asignaciones set vpc = 'VPC Web' where vpc = 'vpc-web'");
    const mala = migrar(b.url, ['--aplicar']);
    assert.equal(mala.status, 1);
    assert.equal((await b.sql('select count(*)::int as n from pools where padre_id is not null')).rows[0].n, 0);
    await b.sql("update asignaciones set vpc = 'vpc-web' where vpc = 'VPC Web'");

    const aplicada = migrar(b.url, ['--aplicar']);
    assert.equal(aplicada.status, 0, aplicada.stderr);
    const hijos = (
      await b.sql(
        'select id, cidr::text, proyecto, vpc, padre_id, mascara_defecto, mascara_minima, mascara_maxima from pools where padre_id is not null order by id',
      )
    ).rows;
    assert.deepEqual(
      hijos.map((h) => [h.id, h.cidr, h.proyecto, h.padre_id]),
      [
        ['vpc-api', '10.200.48.0/24', 'hub-tres', 'dev-gcp-ccla'],
        ['vpc-datos', '10.200.16.0/22', 'hub-dos', 'dev-gcp-ccla'],
        ['vpc-hub', '10.200.0.0/22', 'hub-uno', 'dev-gcp-ccla'],
        ['vpc-lab', '10.200.64.0/24', 'hub-cuatro', 'dev-gcp-ccla'],
        ['vpc-web', '10.200.32.0/24', 'hub-tres', 'dev-gcp-ccla'],
      ],
    );
    assert.deepEqual([hijos[2].mascara_defecto, hijos[2].mascara_minima, hijos[2].mascara_maxima], [24, 22, 28], 'hereda los límites que caben');
    assert.equal((await b.sql("select count(*)::int as n from asignaciones where pool_id = 'dev-gcp-ccla'")).rows[0].n, 0, 'el padre ya no tiene lo repartido');
    assert.equal((await b.sql("select count(*)::int as n from asignaciones where pool_id = 'vpc-hub'")).rows[0].n, 2);
    assert.equal((await b.sql("select pool_id from direcciones_ip where dispositivo = 'fw'")).rows[0].pool_id, 'vpc-datos', 'la IP fija siguió a su segmento');
    assert.equal((await b.sql("select count(*)::int as n from auditoria where usuario = 'migracion-vpc' and accion = 'crear_pool'")).rows[0].n, 5);
    // Repetir no hace nada (ya no hay asignaciones en el padre) y el padre descuenta los bloques.
    assert.equal(migrar(b.url, ['--aplicar']).status, 1);
    const usado = (await b.sql("select sum(2^(32-masklen(cidr))) as n from pools where padre_id = 'dev-gcp-ccla'")).rows[0].n;
    assert.equal(Number(usado), 1024 + 1024 + 256 + 256 + 256);
  } finally {
    await b.borrar();
  }
});
