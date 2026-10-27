// Las alertas y el dashboard: lo versionado coincide con su generador y TODA métrica que citan existe de verdad en /metrics.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { salidas, ALERTAS } = require('../../scripts/ci/generar-alertas');
const { crearMetricas } = require('./adaptadores/metricas/prom');

const RAIZ = path.join(__dirname, '..', '..');
const metricas = crearMetricas({ repo: {}, log: { warn() {} } });
const conocidas = new Set(metricas.registro.getMetricsAsArray().map((m) => m.name));

test('lo versionado en docs/ coincide con lo que genera scripts/ci/generar-alertas.js (sin deriva)', () => {
  for (const [ruta, contenido] of Object.entries(salidas())) {
    const f = path.join(RAIZ, ruta);
    assert.ok(fs.existsSync(f), `falta ${ruta}: ejecuta node scripts/ci/generar-alertas.js`);
    assert.equal(fs.readFileSync(f, 'utf8'), contenido, `${ruta} está desviado: ejecuta node scripts/ci/generar-alertas.js`);
  }
});

test('cada alerta y cada panel del dashboard usan solo métricas que expone el IPAM', () => {
  const textos = [
    ...ALERTAS.map((a) => a.query),
    ...JSON.stringify(JSON.parse(salidas()['docs/ops/gcp/dashboard-ipam.json'])).match(/"prometheusQuery":"[^"]+"/g),
  ];
  let revisadas = 0;
  for (const q of textos) {
    for (const m of String(q).matchAll(/\bipam_[a-z0-9_]+/g)) {
      const base = m[0].replace(/_(bucket|count|sum)$/, '');
      assert.ok(conocidas.has(m[0]) || conocidas.has(base), `la consulta «${q}» cita ${m[0]}, que /metrics no expone`);
      revisadas += 1;
    }
  }
  assert.ok(revisadas >= 15);
});

test('están las alertas pedidas, con los umbrales acordados', () => {
  const q = Object.fromEntries(ALERTAS.map((a) => [a.id, a]));
  assert.match(q.IpamPoolSobre80.query, /ipam_pool_utilizacion_ratio > 0\.8/);
  assert.match(q.IpamPoolSobre90.query, /ipam_pool_utilizacion_ratio > 0\.9/);
  assert.equal(q.IpamPoolSobre90.severidad, 'critical');
  assert.match(q.IpamBaseDeDatosCaida.query, /ipam_db_up == 0/);
  assert.match(q.IpamBarredorDetenido.query, /ipam_barredor_ultima_ejecucion_timestamp > 300/);
  assert.match(q.IpamBarredorDetenido.doc, /SIEMPRE encendido/);
  assert.match(q.IpamPicoDe401.query, /codigo="401"/);
  assert.match(q.IpamPicoDe429.query, /codigo="429"/);
  assert.match(q.IpamTokenPorVencer.query, /ipam_tokens_por_vencer/);
  assert.match(q.IpamTasaDe5xx.query, /codigo=~"5\.\."/);
  for (const a of ALERTAS) assert.ok(a.doc.length > 30 && a.resumen, `${a.id} sin documentación`);
});

test('el dashboard tiene utilización por pool, reservas por estado, latencia p95 y errores', () => {
  const d = JSON.parse(salidas()['docs/ops/gcp/dashboard-ipam.json']);
  const titulos = d.mosaicLayout.tiles.map((t) => t.widget.title).join(' | ');
  for (const clave of ['Utilización por pool', 'Reservas por estado', 'Latencia p95', 'Errores 5xx']) assert.match(titulos, new RegExp(clave));
  assert.ok(d.mosaicLayout.tiles.some((t) => /histogram_quantile\(0\.95/.test(t.widget.xyChart.dataSets[0].timeSeriesQuery.prometheusQuery)));
});
