// Formulario y diálogo para crear y reservar un nuevo Clúster Kubernetes / GKE atómicamente.
import { api, errorApi, get, h, puede } from './base.js';
import { abrirDialogo, toast } from './ui.js';

async function asegurarMapeosPoolUso(amb, pools) {
  const [poolUso, todosPools] = await Promise.all([get('/api/v1/pool-uso').catch(() => []), get('/api/v1/pools').catch(() => pools)]);
  const mapeos = [
    { uso: 'subnet', alias: 'nodos' },
    { uso: 'pods', alias: 'pods' },
    { uso: 'servicios', alias: 'servicios' },
  ];
  for (const { uso, alias } of mapeos) {
    const existe = poolUso.some((u) => u.ambiente === amb && (u.uso === uso || u.uso === alias));
    if (!existe) {
      const candidato = todosPools.find((p) => p.ambiente === amb && (p.tipo.toLowerCase() === uso || p.tipo.toLowerCase() === alias));
      if (candidato && puede('admin')) {
        await api(`/api/v1/pool-uso/${amb}/${uso}`, { method: 'PUT', body: { pool: candidato.id } });
      }
    }
  }
}

function crearSelectoresRed() {
  const selectNodos = h(
    'select',
    { id: 'cl-m-nodos' },
    [24, 23, 22, 21, 20, 25, 26].map((m) => h('option', { value: m, selected: m === 24 }, `/${m} (${(2 ** (32 - m)).toLocaleString('es-CL')} IPs)`)),
  );
  const selectPods = h(
    'select',
    { id: 'cl-m-pods' },
    [16, 17, 18, 19, 20, 14, 15].map((m) => h('option', { value: m, selected: m === 16 }, `/${m} (${(2 ** (32 - m)).toLocaleString('es-CL')} IPs)`)),
  );
  const selectSvc = h(
    'select',
    { id: 'cl-m-svc' },
    [20, 21, 22, 23, 24].map((m) => h('option', { value: m, selected: m === 20 }, `/${m} (${(2 ** (32 - m)).toLocaleString('es-CL')} IPs)`)),
  );
  return { selectNodos, selectPods, selectSvc };
}

export function dialogoNuevoCluster(pools, recargar) {
  abrirDialogo((dlg, cerrar) => {
    const error = h('div', { id: 'cl-err', class: 'alert hide', role: 'alert' });
    const ambientes = [...new Set(pools.map((p) => p.ambiente))].filter(Boolean);
    if (!ambientes.includes('qa')) ambientes.unshift('qa');
    if (!ambientes.includes('prod')) ambientes.push('prod');

    const inputProyecto = h('input', {
      id: 'cl-proyecto',
      required: true,
      pattern: '[a-z0-9][a-z0-9-]{1,60}',
      placeholder: 'p. ej. cluster-core-qa',
      title: 'Minúsculas, números y guiones',
    });
    const selectAmbiente = h(
      'select',
      { id: 'cl-ambiente' },
      ambientes.map((a) => h('option', { value: a }, a.toUpperCase())),
    );
    const inputSubred = h('input', { id: 'cl-subred', placeholder: 'p. ej. subred-qa-k8s (opcional)' });
    const { selectNodos, selectPods, selectSvc } = crearSelectoresRed();
    const inputTicket = h('input', { id: 'cl-ticket', placeholder: 'p. ej. INFRA-101 (opcional)' });
    const checkAprobar = h('input', { id: 'cl-aprobar', type: 'checkbox', checked: puede('admin'), style: 'width:auto' });
    const botonCrear = h('button', { class: 'btn', type: 'submit' }, 'Crear y reservar clúster');

    const procesarEnvio = async (e) => {
      e.preventDefault();
      error.classList.add('hide');
      botonCrear.disabled = true;
      botonCrear.textContent = 'Reservando rangos...';
      try {
        const amb = selectAmbiente.value;
        const proy = inputProyecto.value.trim().toLowerCase();
        await asegurarMapeosPoolUso(amb, pools);

        const bodyLote = {
          ambiente: amb,
          proyecto: proy,
          subred: inputSubred.value.trim().toLowerCase() || undefined,
          ticket: inputTicket.value.trim() || undefined,
          rangos: [
            { uso: 'subnet', mascara: Number(selectNodos.value), nombre: 'nodos' },
            { uso: 'pods', mascara: Number(selectPods.value), nombre: 'pods' },
            { uso: 'servicios', mascara: Number(selectSvc.value), nombre: 'servicios' },
          ],
        };
        const resLote = await api('/api/v1/reservas/lote', { body: bodyLote });
        if (!resLote.ok) throw new Error(errorApi(resLote));

        const grupoId = resLote.data && resLote.data.grupo ? resLote.data.grupo.grupo : null;
        if (checkAprobar.checked && grupoId && puede('admin')) {
          botonCrear.textContent = 'Aprobando grupo...';
          await api(`/api/v1/reservas/grupo/${grupoId}/confirmar`, { body: {} });
        }
        toast(`Clúster «${proy}» creado con éxito.`, 'ok');
        cerrar();
        await recargar();
      } catch (err) {
        error.textContent = err.message || 'Error al crear el clúster';
        error.classList.remove('hide');
        botonCrear.disabled = false;
        botonCrear.textContent = 'Crear y reservar clúster';
      }
    };

    const form = h(
      'form',
      { onsubmit: procesarEnvio },
      h('h3', null, 'Nuevo Clúster Kubernetes / GKE'),
      h('p', { class: 'muted', style: 'margin-top:-8px;font-size:13px' }, 'Reserva atómica de los 3 rangos simultáneos (Subnet, Pods y Servicios).'),
      error,
      h('label', { for: 'cl-proyecto' }, 'Nombre del clúster / Proyecto *'),
      inputProyecto,
      h(
        'div',
        { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px' },
        h('div', null, h('label', { for: 'cl-ambiente' }, 'Ambiente *'), selectAmbiente),
        h('div', null, h('label', { for: 'cl-subred' }, 'Nombre Subred / VPC'), inputSubred),
      ),
      h(
        'fieldset',
        { style: 'border:1px solid var(--line,#334155);border-radius:6px;padding:12px;margin:12px 0' },
        h('legend', { style: 'font-weight:600;padding:0 6px;color:var(--text,#f8fafc)' }, 'Dimensiones de red'),
        h(
          'div',
          { style: 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px' },
          h('div', null, h('label', { for: 'cl-m-nodos' }, 'Subnet (Nodos)'), selectNodos),
          h('div', null, h('label', { for: 'cl-m-pods' }, 'Pods'), selectPods),
          h('div', null, h('label', { for: 'cl-m-svc' }, 'Servicios'), selectSvc),
        ),
      ),
      h('label', { for: 'cl-ticket' }, 'Ticket / Referencia'),
      inputTicket,
      puede('admin')
        ? h(
            'label',
            { class: 'casilla', style: 'display:flex;gap:8px;align-items:center;margin:12px 0' },
            checkAprobar,
            h('span', null, 'Aprobar inmediatamente como asignación definitiva'),
          )
        : null,
      h(
        'div',
        { class: 'fila-botones', style: 'display:flex;justify-content:flex-end;gap:8px;margin-top:16px' },
        h('button', { class: 'btn sec', type: 'button', onclick: cerrar }, 'Cancelar'),
        botonCrear,
      ),
    );

    dlg.replaceChildren(form);
    inputProyecto.focus();
  });
}
