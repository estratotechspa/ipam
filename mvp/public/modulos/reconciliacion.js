// Pestaña Reconciliación: detección de Cloud Drift entre la nube real y el IPAM.
import { $, I, api, errorApi, esc, fail, get, msg, post } from './base.js';
import { toast } from './ui.js';

const ESCENARIOS = {
  sincronizado: [
    { subred: '10.10.0.0/20', cidr: '10.10.0.0/20', vpc: 'vpc-pagos', proyecto: 'mlopez', ambiente: 'prod', proveedor: 'aws' },
    { subred: '10.10.16.0/20', cidr: '10.10.16.0/20', vpc: 'vpc-clientes', proyecto: 'jperez', ambiente: 'prod', proveedor: 'aws' },
    { subred: '10.20.0.0/20', cidr: '10.20.0.0/20', vpc: 'vpc-qa', proyecto: 'cquiroz', ambiente: 'qa', proveedor: 'gcp' },
  ],
  shadow_it: [
    { subred: '10.10.0.0/20', cidr: '10.10.0.0/20', vpc: 'vpc-pagos', proyecto: 'mlopez', ambiente: 'prod', proveedor: 'aws' },
    { subred: '10.10.16.0/20', cidr: '10.10.16.0/20', vpc: 'vpc-clientes', proyecto: 'jperez', ambiente: 'prod', proveedor: 'aws' },
    { subred: '10.20.0.0/20', cidr: '10.20.0.0/20', vpc: 'vpc-qa', proyecto: 'cquiroz', ambiente: 'qa', proveedor: 'gcp' },
    { subred: '10.20.99.0/24', cidr: '10.20.99.0/24', vpc: 'vpc-no-autorizada', proyecto: 'desconocido', ambiente: 'qa', proveedor: 'gcp' },
    { subred: '10.10.48.0/24', cidr: '10.10.48.0/24', vpc: 'vpc-sombra-dev', proyecto: 'lab-ia', ambiente: 'prod', proveedor: 'aws' },
  ],
  fantasma: [{ subred: '10.10.0.0/20', cidr: '10.10.0.0/20', vpc: 'vpc-pagos', proyecto: 'mlopez', ambiente: 'prod', proveedor: 'aws' }],
};

export async function renderReconciliacion() {
  const contenedor = $('reconciliacion');
  contenedor.innerHTML = `
    <div class="cabecera" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
      <div>
        <h2 tabindex="-1" style="margin-bottom:4px">Reconciliación de Nube (Cloud Drift)</h2>
        <p class="muted" style="margin:0">Auditoría continua de discrepancias entre proveedores cloud (AWS / GCP / Azure) y la base de datos IPAM.</p>
      </div>
      <div class="telemetria"><span class="telemetria-dot pulso"></span><span>AUDITOR EN LÍNEA</span></div>
    </div>

    <!-- Guía Explicativa -->
    <div class="card" style="margin-bottom:var(--sp-4);background:rgba(15, 23, 42, 0.6);border:1px solid var(--line, #334155)">
      <div style="font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:8px">
        ${I('info', 16)} ¿Para qué sirve la Reconciliación y qué problemas resuelve?
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(240px, 1fr));gap:12px;font-size:13px;line-height:1.5">
        <div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);border-radius:6px;padding:10px 12px">
          <b style="color:#f87171">1. Detección de Shadow IT (Drift):</b>
          <p class="muted" style="margin:4px 0 0">Identifica subredes creadas en la nube sin registrar en IPAM. Evita colisiones catastróficas de red al permitir <b>adoptarlas con 1 clic</b>.</p>
        </div>
        <div style="background:rgba(234,179,8,0.08);border:1px solid rgba(234,179,8,0.25);border-radius:6px;padding:10px 12px">
          <b style="color:#facc15">2. Limpieza de Recursos Fantasma:</b>
          <p class="muted" style="margin:4px 0 0">Detecta asignaciones en IPAM que ya fueron destruidas en AWS/GCP, recuperando direcciones IP libres para nuevos proyectos.</p>
        </div>
        <div style="background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.25);border-radius:6px;padding:10px 12px">
          <b style="color:#4ade80">3. Conformidad y Gobernanza:</b>
          <p class="muted" style="margin:4px 0 0">Garantiza que la topología de red real cumpla con las políticas de nombres de VPC, cuentas y ambientes de la empresa.</p>
        </div>
      </div>
    </div>

    <!-- Panel de Ejecución -->
    <div class="card" style="margin-bottom:var(--sp-4)">
      <h3>Ejecutar Auditoría de Discrepancias</h3>
      <p class="muted">Selecciona un escenario de escaneo o ingresa telemetría directa enviada por el agente de red:</p>
      
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px">
        <button type="button" class="btn sec" id="recon-esc-shadow" style="border-color:#f87171;color:#f87171">
          ${I('alerta', 16)} Simular Alerta de Shadow IT (Subredes no registradas)
        </button>
        <button type="button" class="btn sec" id="recon-esc-sync">
          ${I('ok', 16)} Simular Nube Sincronizada
        </button>
        <button type="button" class="btn sec" id="recon-esc-fantasma">
          ${I('reintentar', 16)} Simular Recursos Fantasma
        </button>
      </div>

      <details class="plegable" style="margin-bottom:16px">
        <summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--text, #f8fafc)">
          Inspeccionar o editar JSON de telemetría de nube
        </summary>
        <div style="margin-top:10px">
          <label for="recon-json" class="sr-only">Inventario JSON de subredes</label>
          <textarea id="recon-json" rows="6" style="font-family:ui-monospace,monospace;font-size:var(--fs-xs)" placeholder='[{"subred": "10.20.1.0/24", "vpc": "vpc-123", "proyecto": "core", "ambiente": "prod", "proveedor": "aws"}]'></textarea>
          <button type="button" class="btn sec pequeno" id="recon-limpiar" style="margin-top:6px">Limpiar datos</button>
        </div>
      </details>

      <div class="acciones">
        <button type="button" class="btn" id="recon-ejecutar">
          ${I('sincronizar')} Auditar y comparar con base de datos IPAM
        </button>
      </div>
    </div>

    <div id="recon-msg" aria-live="polite"></div>
    <div id="recon-resultados"></div>
  `;

  $('recon-esc-shadow').onclick = () => cargarEscenario('shadow_it');
  $('recon-esc-sync').onclick = () => cargarEscenario('sincronizado');
  $('recon-esc-fantasma').onclick = () => cargarEscenario('fantasma');
  $('recon-limpiar').onclick = () => {
    $('recon-json').value = '';
    $('recon-resultados').innerHTML = '';
  };
  $('recon-ejecutar').onclick = ejecutarAuditoria;

  // Cargar por defecto el escenario de demostración de Shadow IT
  cargarEscenario('shadow_it');
}

function cargarEscenario(tipo) {
  const datos = ESCENARIOS[tipo] || ESCENARIOS.shadow_it;
  $('recon-json').value = JSON.stringify(datos, null, 2);
  ejecutarAuditoria();
}

async function ejecutarAuditoria() {
  const raw = $('recon-json').value.trim();
  if (!raw) {
    msg($('recon-msg'), 'Ingresa o selecciona un escenario de subredes de la nube.', 'alerta');
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
  const badgeEstado = (est) => {
    if (est === 'en_sincronia') return '<span class="tag ok" style="background:#166534;color:#dcfce7">En sincronia</span>';
    if (est === 'desviacion_no_registrada') return '<span class="tag peligro" style="background:#991b1b;color:#fee2e2">Shadow IT (No registrada)</span>';
    if (est === 'huerfana_en_ipam') return '<span class="tag aviso" style="background:#854d0e;color:#fef9c3">Fantasma en IPAM</span>';
    if (est === 'discrepancia_metadatos') return '<span class="tag aviso" style="background:#9a3412;color:#ffedd5">Metadatos distintos</span>';
    return `<span class="tag">${esc(est)}</span>`;
  };

  c.innerHTML = `
    <div class="kpis" style="margin-bottom:var(--sp-4)">
      <div class="card"><div class="kpi">${r.total_nube}</div><div class="sub">Total en nube</div></div>
      <div class="card"><div class="kpi" style="color:var(--exito)">${r.sincronizados}</div><div class="sub">Sincronizados</div></div>
      <div class="card"><div class="kpi ${r.desviaciones ? 'uso-txt-alto' : ''}">${r.desviaciones}</div><div class="sub">Desviaciones (drift)</div></div>
      <div class="card"><div class="kpi ${r.huerfanos_nube ? 'uso-txt-alto' : ''}">${r.huerfanos_nube}</div><div class="sub">Shadow IT (No registradas)</div></div>
      <div class="card"><div class="kpi ${r.huerfanos_ipam ? 'uso-txt-medio' : ''}">${r.huerfanos_ipam || 0}</div><div class="sub">Fantasmas en IPAM</div></div>
    </div>
    <div class="card tablewrap" tabindex="0" role="region" aria-label="Resultados de reconciliación">
      <div style="font-weight:600;margin-bottom:8px">Hallazgos y Acciones de Remediación</div>
      <table>
        <thead>
          <tr>
            <th scope="col">Estado</th>
            <th scope="col">Subred (Nube / IPAM)</th>
            <th scope="col">VPC</th>
            <th scope="col">Proyecto</th>
            <th scope="col">Diagnóstico</th>
            <th scope="col">Acción</th>
          </tr>
        </thead>
        <tbody>
          ${res.detalles
            .map((d, i) => {
              const cidr = d.subred || d.cidr || '—';
              let accionHtml = '<span class="muted">—</span>';
              if (d.estado === 'desviacion_no_registrada') {
                accionHtml = `<button type="button" class="btn sec pequeno" data-adoptar="${esc(cidr)}" data-vpc="${esc(d.vpc || '')}" data-proy="${esc(d.proyecto || '')}">Adoptar en IPAM</button>`;
              } else if (d.estado === 'huerfana_en_ipam' && d.asignacion_id) {
                accionHtml = `<button type="button" class="btn sec peligro pequeno" data-liberar="${esc(d.asignacion_id)}" data-c="${esc(cidr)}">Liberar IPAM</button>`;
              } else if (d.estado === 'en_sincronia') {
                accionHtml = '<span style="color:var(--exito);font-size:12px;font-weight:600">Conforme</span>';
              }
              return `<tr>
                <td>${badgeEstado(d.estado)}</td>
                <td><code>${esc(cidr)}</code></td>
                <td>${esc(d.vpc || '—')}</td>
                <td>${esc(d.proyecto || '—')}</td>
                <td>${esc(d.mensaje || '—')}</td>
                <td>${accionHtml}</td>
              </tr>`;
            })
            .join('')}
        </tbody>
      </table>
    </div>
  `;

  // Asignar listeners de acciones de remediación
  c.querySelectorAll('[data-adoptar]').forEach((b) => {
    b.onclick = () => adoptarEnIpam(b.dataset.adoptar, b.dataset.vpc, b.dataset.proy);
  });
  c.querySelectorAll('[data-liberar]').forEach((b) => {
    b.onclick = () => liberarHuerfano(b.dataset.liberar, b.dataset.c);
  });
}

async function adoptarEnIpam(cidr, vpc, proyecto) {
  try {
    const pools = await get('/api/v1/pools');
    // Encontrar pool que contenga al CIDR o el primero que sirva
    const pool = pools[0];
    if (!pool) throw new Error('No hay pools disponibles en el sistema.');

    const res = await api('/api/v1/solicitudes', {
      body: {
        pool: pool.id,
        cidr: cidr,
        vpc: vpc || 'vpc-adoptada',
        proyecto: proyecto || 'infra-recon',
        ticket: 'RECON-ADOPT',
      },
    });
    if (!res.ok) throw new Error(errorApi(res));

    toast(`Subred «${cidr}» adoptada con éxito en el pool «${pool.id}».`, 'ok');
    ejecutarAuditoria();
  } catch (e) {
    toast('No se pudo adoptar: ' + e.message, 'error');
  }
}

async function liberarHuerfano(id, cidr) {
  try {
    const res = await api(`/api/v1/asignaciones/${id}`, { method: 'DELETE', body: {} });
    if (!res.ok) throw new Error(errorApi(res));

    toast(`Recurso fantasma «${cidr}» liberado de IPAM.`, 'ok');
    ejecutarAuditoria();
  } catch (e) {
    toast('No se pudo liberar: ' + e.message, 'error');
  }
}
