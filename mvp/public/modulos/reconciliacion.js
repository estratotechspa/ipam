// Pestaña Reconciliación: detección de Cloud Drift entre la nube real y el IPAM.
import { $, I, esc, fail, msg, post } from './base.js';

const EJEMPLO_AWS = [
  {
    subred: '10.20.1.0/24',
    cidr: '10.20.1.0/24',
    vpc: 'vpc-prod-core',
    proyecto: 'infra-latam',
    ambiente: 'prod',
    proveedor: 'aws',
  },
  {
    subred: '10.20.2.0/24',
    cidr: '10.20.2.0/24',
    vpc: 'vpc-prod-core',
    proyecto: 'infra-latam',
    ambiente: 'prod',
    proveedor: 'aws',
  },
  {
    subred: '10.20.99.0/24',
    cidr: '10.20.99.0/24',
    vpc: 'vpc-sombra-dev',
    proyecto: 'sombra',
    ambiente: 'dev',
    proveedor: 'aws',
  },
];

export async function renderReconciliacion() {
  const contenedor = $('reconciliacion');
  contenedor.innerHTML = `
    <div class="cabecera">
      <h2 tabindex="-1">Reconciliación de Nube (Cloud Drift)</h2>
      <div class="telemetria"><span class="telemetria-dot pulso"></span><span>MOTOR RECON EN LÍNEA</span></div>
    </div>
    <div class="card" style="margin-bottom:var(--sp-4)">
      <h3>Inventario descubierto en la Nube (AWS / GCP / Azure)</h3>
      <p class="muted">Ingresa la telemetría de subredes descubiertas por el agente de redes o el scanner de nube para auditar discrepancias con el IPAM.</p>
      <div style="display:flex;gap:var(--sp-2);margin-bottom:var(--sp-2)">
        <button type="button" class="btn sec pequeno" id="recon-cargar-ejemplo">Cargar ejemplo AWS</button>
        <button type="button" class="btn sec pequeno" id="recon-limpiar">Limpiar</button>
      </div>
      <label for="recon-json" class="sr-only">Inventario JSON de subredes</label>
      <textarea id="recon-json" rows="6" style="font-family:ui-monospace,monospace;font-size:var(--fs-xs);margin-bottom:var(--sp-2)" placeholder='[{"subred": "10.20.1.0/24", "vpc": "vpc-123", "proyecto": "core", "ambiente": "prod", "proveedor": "aws"}]'></textarea>
      <div class="acciones">
        <button type="button" class="btn" id="recon-ejecutar">${I('sincronizar')} Auditar discrepancias</button>
      </div>
    </div>
    <div id="recon-msg" aria-live="polite"></div>
    <div id="recon-resultados"></div>
  `;

  $('recon-cargar-ejemplo').onclick = () => {
    $('recon-json').value = JSON.stringify(EJEMPLO_AWS, null, 2);
  };
  $('recon-limpiar').onclick = () => {
    $('recon-json').value = '';
    $('recon-resultados').innerHTML = '';
  };
  $('recon-ejecutar').onclick = ejecutarAuditoria;
}

async function ejecutarAuditoria() {
  const raw = $('recon-json').value.trim();
  if (!raw) {
    msg($('recon-msg'), 'Ingresa un arreglo JSON con las subredes de la nube.', 'alerta');
    return;
  }
  let subredes;
  try {
    subredes = JSON.parse(raw);
    if (!Array.isArray(subredes)) throw new Error('El JSON debe ser un arreglo de subredes.');
  } catch (e) {
    msg($('recon-msg'), 'JSON inválido: ' + e.message, 'alerta');
    return;
  }

  $('recon-ejecutar').disabled = true;
  $('recon-resultados').innerHTML = '<p class="cargando">Reconciliando inventario contra base de datos IPAM…</p>';
  try {
    const res = await post('/api/v1/reconciliacion', { subredes_nube: subredes });
    renderResultados(res);
  } catch (e) {
    fail('recon-resultados', e);
  } finally {
    $('recon-ejecutar').disabled = false;
  }
}

function renderResultados(res) {
  const r = res.resumen;
  const c = $('recon-resultados');
  c.innerHTML = `
    <div class="kpis" style="margin-bottom:var(--sp-4)">
      <div class="card"><div class="kpi">${r.total_nube}</div><div class="sub">Total en nube</div></div>
      <div class="card"><div class="kpi" style="color:var(--exito)">${r.sincronizados}</div><div class="sub">Sincronizados</div></div>
      <div class="card"><div class="kpi ${r.desviaciones ? 'uso-txt-alto' : ''}">${r.desviaciones}</div><div class="sub">Desviaciones (drift)</div></div>
      <div class="card"><div class="kpi ${r.huerfanos_nube ? 'uso-txt-medio' : ''}">${r.huerfanos_nube}</div><div class="sub">Huérfanos en nube</div></div>
      <div class="card"><div class="kpi">${r.discrepancias_metadata}</div><div class="sub">Discrepancias meta</div></div>
    </div>
    <div class="card tablewrap" tabindex="0" role="region" aria-label="Resultados de reconciliación">
      <table>
        <thead>
          <tr>
            <th scope="col">Estado</th>
            <th scope="col">Subred (Nube)</th>
            <th scope="col">VPC</th>
            <th scope="col">Proyecto</th>
            <th scope="col">Detalle / Hallazgo</th>
          </tr>
        </thead>
        <tbody>
          ${res.detalles
            .map(
              (d) => `<tr>
            <td><span class="tag ${esc(d.estado)}">${esc(d.estado)}</span></td>
            <td><code>${esc(d.subred || '—')}</code></td>
            <td>${esc(d.vpc || '—')}</td>
            <td>${esc(d.proyecto || '—')}</td>
            <td>${esc(d.mensaje || '—')}</td>
          </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}
