// Cliente REST de Jira Cloud (IPAM → Jira). DESACTIVADO por defecto: solo actúa con JIRA_ENABLED=true.
// Variables: JIRA_BASE_URL (https://empresa.atlassian.net), JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT (clave, ej. NET),
// JIRA_ISSUE_TYPE (por defecto "Task"), JIRA_DONE_TRANSITION (nombre de la transición final, por defecto "Done").
const env = process.env;
const enabled = () => String(env.JIRA_ENABLED || '').toLowerCase() === 'true';
const faltantes = () => ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT'].filter((k) => !env[k]);

async function llamar(metodo, ruta, cuerpo) {
  const auth = Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64');
  const r = await fetch(env.JIRA_BASE_URL.replace(/\/+$/, '') + ruta, {
    method: metodo,
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const texto = await r.text();
  if (!r.ok) throw new Error(`Jira ${metodo} ${ruta} → ${r.status} ${texto.slice(0, 200)}`);
  return texto ? JSON.parse(texto) : null;
}
const adf = (t) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });

// Crea el ticket de una solicitud hecha en el panel y devuelve su clave (ej. NET-57).
async function crearTicket(a) {
  const r = await llamar('POST', '/rest/api/3/issue', {
    fields: {
      project: { key: env.JIRA_PROJECT },
      issuetype: { name: env.JIRA_ISSUE_TYPE || 'Task' },
      summary: `Segmento ${a.cidr} · ${a.pool_id} · ${a.vpc}`,
      description: adf(`IPAM asignó ${a.cidr} del pool ${a.pool_id} al proyecto/VPC ${a.vpc}. Solicitó: ${a.solicitante}.`),
    },
  });
  return r.key;
}

// Informa el rango en un ticket existente (viene de Jira) y lo pasa a su estado final.
async function actualizarTicket(clave, a) {
  await llamar('POST', `/rest/api/3/issue/${encodeURIComponent(clave)}/comment`, {
    body: adf(`IPAM asignó el segmento ${a.cidr} (pool ${a.pool_id}, VPC ${a.vpc}).`),
  });
  const { transitions } = await llamar('GET', `/rest/api/3/issue/${encodeURIComponent(clave)}/transitions`);
  const destino = (env.JIRA_DONE_TRANSITION || 'Done').toLowerCase();
  const t = transitions.find((x) => x.name.toLowerCase() === destino);
  if (!t) throw new Error(`Sin transición «${env.JIRA_DONE_TRANSITION || 'Done'}» en ${clave}`);
  await llamar('POST', `/rest/api/3/issue/${encodeURIComponent(clave)}/transitions`, { transition: { id: t.id } });
}

// El webhook se firma con JIRA_WEBHOOK_SECRET. Sin él (o con el valor de ejemplo, que es público) cualquiera podría
// fabricar peticiones válidas: en producción la app no arranca así.
const SECRETO_DE_EJEMPLO = 'dev-secret-cambiar';
function validarSecretoWebhook(e = env) {
  if (e.NODE_ENV !== 'production') return;
  if (!e.JIRA_WEBHOOK_SECRET || e.JIRA_WEBHOOK_SECRET === SECRETO_DE_EJEMPLO) {
    throw new Error('En producción JIRA_WEBHOOK_SECRET es obligatorio y no puede ser el valor de ejemplo («' + SECRETO_DE_EJEMPLO + '»)');
  }
}

module.exports = { enabled, faltantes, crearTicket, actualizarTicket, validarSecretoWebhook, SECRETO_DE_EJEMPLO };
