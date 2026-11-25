'use strict';
// Cliente REST de Jira Cloud (IPAM → Jira). DESACTIVADO por defecto: solo actúa con JIRA_ENABLED=true.
// Implementa el puerto TicketsExternos. La configuración (JIRA_*) viene del módulo config.
const { config } = require('../../config');

const activo = () => config.jira.activa;
const faltantes = () => {
  const j = config.jira;
  return [
    ['JIRA_BASE_URL', j.baseUrl],
    ['JIRA_EMAIL', j.email],
    ['JIRA_API_TOKEN', j.apiToken],
    ['JIRA_PROJECT', j.proyecto],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
};

async function llamar(metodo, ruta, cuerpo) {
  const j = config.jira;
  const auth = Buffer.from(`${j.email}:${j.apiToken}`).toString('base64');
  const r = await fetch(j.baseUrl.replace(/\/+$/, '') + ruta, {
    method: metodo,
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  const texto = await r.text();
  if (!r.ok) throw new Error(`Jira ${metodo} ${ruta} → ${r.status} ${texto.slice(0, 200)}`);
  return texto ? JSON.parse(texto) : null;
}
const adf = (t) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });

/** Crea el ticket de una solicitud hecha en el panel y devuelve su clave (ej. NET-57). */
async function crear(a) {
  const j = config.jira;
  const r = await llamar('POST', '/rest/api/3/issue', {
    fields: {
      project: { key: j.proyecto },
      issuetype: { name: j.tipoTicket },
      summary: `Segmento ${a.cidr} · ${a.pool_id} · ${a.vpc}`,
      description: adf(`IPAM asignó ${a.cidr} del pool ${a.pool_id} al proyecto/VPC ${a.vpc}. Solicitó: ${a.solicitante}.`),
    },
  });
  return r.key;
}

/** Informa el rango en un ticket existente (viene de Jira) y lo pasa a su estado final. */
async function actualizar(clave, a) {
  await llamar('POST', `/rest/api/3/issue/${encodeURIComponent(clave)}/comment`, {
    body: adf(`IPAM asignó el segmento ${a.cidr} (pool ${a.pool_id}, VPC ${a.vpc}).`),
  });
  const { transitions } = await llamar('GET', `/rest/api/3/issue/${encodeURIComponent(clave)}/transitions`);
  const destino = config.jira.transicionFinal.toLowerCase();
  const t = transitions.find((x) => x.name.toLowerCase() === destino);
  if (!t) throw new Error(`Sin transición «${config.jira.transicionFinal}» en ${clave}`);
  await llamar('POST', `/rest/api/3/issue/${encodeURIComponent(clave)}/transitions`, { transition: { id: t.id } });
}

module.exports = { activo, faltantes, crear, actualizar };
