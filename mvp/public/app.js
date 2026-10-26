import {icono} from '/iconos.js';
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=n=>Number(n).toLocaleString('es-CL');
const fecha=s=>new Date(s).toLocaleDateString('es-CL');
const size=c=>2**(32-Number(c.split('/')[1]));
const tag=a=>`<span class="tag ${esc(a)}">${esc(a)}</span>`;
const I=icono;
const CAB={'X-Requested-With':'ipam'};
async function api(url,opt){
  const init=opt&&opt.body!==undefined?{method:opt.method||'POST',headers:{'Content-Type':'application/json',...CAB},body:JSON.stringify(opt.body)}:{headers:CAB,method:(opt&&opt.method)||'GET'};
  const r=await fetch(url,init);
  if(r.status===401&&YO.modo==='oidc'){location.href='/login?error=sesion&next='+encodeURIComponent(location.pathname);return {ok:false,status:401,data:null}}
  let j=null;try{j=await r.json()}catch(e){}
  return {ok:r.ok,status:r.status,data:j,total:Number(r.headers.get('X-Total-Count'))};
}
let YO={modo:'none',rol:'admin',usuario:'',nombre:''};
const NIVEL={lector:0,solicitante:1,admin:2};
const puede=min=>NIVEL[YO.rol]>=NIVEL[min];
const get=async u=>{const r=await api(u);if(!r.ok)throw new Error('Error '+r.status);return r.data};

function show(t){if(!$(t)||$('nav').querySelector('[data-t="'+t+'"]').hidden)t='pools';document.querySelectorAll('.wrap').forEach(w=>w.classList.toggle('hide',w.id!==t));
  document.querySelectorAll('#nav button').forEach(b=>{const on=b.dataset.t===t;b.classList.toggle('on',on);if(on)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});render(t)}
$('nav').onclick=e=>{const b=e.target.closest('[data-t]');if(b)show(b.dataset.t)};
document.querySelectorAll('#nav [data-ic]').forEach(b=>b.insertAdjacentHTML('afterbegin',I(b.dataset.ic)));
const fail=(id,e)=>$(id).innerHTML=`<div class="alert" role="alert">${I('error')} No se pudo cargar: ${esc(e.message)}</div>`;

async function renderPools(){
  try{const pools=await get('/api/pools');
  const r={pools:pools.length,asignaciones:pools.reduce((n,p)=>n+p.asignaciones,0),uso_promedio:pools.length?pools.reduce((n,p)=>n+p.uso,0)/pools.length:0,solapamientos:0};
  $('pools').innerHTML=`<div class="cabecera"><h2>Estado de pools</h2><a class="btn sec" href="/api/exportar.xlsx" download>${I('descargar')}Exportar a Excel</a></div>
  <div class="row"><div class="card"><div class="kpi">${r.pools}</div><div class="sub">Pools</div></div>
  <div class="card"><div class="kpi">${r.asignaciones}</div><div class="sub">Asignaciones activas</div></div>
  <div class="card"><div class="kpi">${(r.uso_promedio*100).toFixed(1).replace('.',',')}%</div><div class="sub">Uso promedio</div></div>
  <div class="card"><div class="kpi">${r.solapamientos}</div><div class="sub">Solapamientos (la base de datos los impide)</div></div></div>
  <div class="card tablewrap" style="margin-top:var(--sp-4)" tabindex="0" role="region" aria-label="Pools"><table><thead><tr><th scope="col">Pool</th><th scope="col">Tipo</th><th scope="col">Ambiente</th><th scope="col">Proveedor</th><th scope="col">CIDR base</th><th scope="col">Asig.</th><th scope="col">Uso</th></tr></thead><tbody>
  ${pools.map(p=>`<tr><td>${esc(p.id)}</td><td>${esc(p.tipo)}</td><td>${tag(p.ambiente)}</td><td>${esc(p.proveedor)}</td><td><code>${esc(p.cidr)}</code></td><td>${p.asignaciones}</td>
  <td><div class="bar" title="${(p.uso*100).toFixed(2)}%"><i style="width:${Math.max(p.uso*100,1)}%"></i></div></td></tr>`).join('')}</tbody></table></div>`}catch(e){fail('pools',e)}}

async function renderAsig(){
  try{const ra=await api('/api/asignaciones?limit=200');if(!ra.ok)throw new Error('Error '+ra.status);const a=ra.data,total=ra.total||a.length;
  $('asig').innerHTML=`<div class="cabecera"><h2>Asignaciones</h2><span><a class="btn" href="/api/exportar.xlsx" download>${I('descargar')}Exportar a Excel</a> ${puede('admin')?`<a class="btn sec" href="/api/exportar.json" download title="Respaldo completo para llevar el IPAM a otra infraestructura">${I('archivo')}Respaldo JSON</a>`:''}</span></div><div class="card tablewrap" tabindex="0" role="region" aria-label="Asignaciones"><table><thead><tr><th scope="col">Segmento</th><th scope="col">Pool</th><th scope="col">Proyecto / VPC</th><th scope="col">Direcciones</th><th scope="col">Solicitó</th><th scope="col">Origen</th><th scope="col">Ticket</th><th scope="col">Fecha</th><th scope="col"><span class="sr-only">Acciones</span></th></tr></thead><tbody>
  ${a.map(x=>`<tr><td><code>${esc(x.cidr)}</code></td><td>${esc(x.pool_id)}</td><td>${esc(x.vpc)}</td><td>${fmt(size(x.cidr))}</td><td>${esc(x.solicitante)}</td><td>${esc(x.origen)}</td><td>${esc(x.ticket)}</td><td>${fecha(x.creado_en)}</td>
  <td>${puede('admin')?`<button class="btn sec" data-del="${x.id}" data-c="${esc(x.cidr)}">${I('liberar')}Liberar</button>`:''}</td></tr>`).join('')}</tbody></table></div>${total>a.length?`<p class="muted">Se muestran las ${a.length} más recientes de ${total}. El Excel incluye todas.</p>`:''}`;
  $('asig').querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{
    if(!confirm('¿Liberar '+b.dataset.c+'?'))return;
    await api('/api/asignaciones/'+b.dataset.del,{method:'DELETE',body:{}});renderAsig()})}catch(e){fail('asig',e)}}

let pools=[];
async function renderSol(){
  try{pools=await get('/api/pools')}catch(e){return fail('sol',e)}
  $('sol').innerHTML=`<h2>Solicitar segmento</h2><div class="row"><div class="card" style="max-width:420px;flex:none;width:100%">
  <label for="s-pool">Pool</label><select id="s-pool">${pools.map(p=>`<option value="${esc(p.id)}" ${p.id==='gke-pods-prod'?'selected':''}>${esc(p.id)} (${esc(p.cidr)})</option>`).join('')}</select>
  <label for="s-vpc">Proyecto / VPC</label><input id="s-vpc" value="vpc-pagos">
  <label for="s-cidr">CIDR manual (opcional; vacío = asignar el primer libre)</label><input id="s-cidr" value="10.64.8.0/22" placeholder="10.64.16.0/22">
  <label for="s-len">Máscara (si no hay CIDR manual)</label><select id="s-len">${[16,18,19,20,21,22,23,24,26,28].map(n=>`<option ${n===22?'selected':''} value="${n}">/${n}</option>`).join('')}</select>
  <p><button class="btn" id="s-go">${I('mas')}Solicitar</button></p></div>
  <div class="card" id="s-res" aria-live="polite"><p class="muted">Prueba un CIDR que choque con uno existente (ej. 10.64.8.0/22 en gke-pods-prod): la base de datos lo rechaza y se sugieren segmentos libres.</p></div></div>`;
  $('s-go').onclick=solicitar}

async function solicitar(){
  const body={pool:$('s-pool').value,vpc:$('s-vpc').value.trim(),cidr:$('s-cidr').value.trim()||undefined,mascara:+$('s-len').value};
  const res=$('s-res');$('s-go').disabled=true;
  const r=await api('/api/solicitudes',{body});$('s-go').disabled=false;
  const d=r.data||{};
  if(r.ok){res.innerHTML=`<div class="ok" role="status">${I('ok')} Asignado <code>${esc(d.cidr)}</code> en ${esc(d.pool_id)} para ${esc(d.vpc)}. Jira creó el ticket <b>${esc(d.ticket)}</b>.</div><p class="muted">Míralo en la pestaña Asignaciones.</p>`;return}
  if(d.error==='solapamiento'){const x=d.conflicto,len=(body.cidr||'').split('/')[1];
    res.innerHTML=`<div class="alert" role="alert"><b>${I('alerta')} Solapamiento detectado</b><br><code>${esc(body.cidr)}</code> se cruza con <code>${esc(x.cidr)}</code> asignado a <b>${esc(x.vpc)}</b> por <b>${esc(x.solicitante)}</b> el ${fecha(x.creado_en)} (ticket ${esc(x.ticket)}).</div>
    <b>Segmentos libres sugeridos (/${esc(len)})</b><br><br>${d.sugeridos.length?d.sugeridos.map(s=>`<div class="sug"><code>${esc(s)}</code><button class="btn" data-use="${esc(s)}">Usar</button></div>`).join(''):'<p class="muted">No hay segmentos libres de ese tamaño.</p>'}`;
    res.querySelectorAll('[data-use]').forEach(b=>b.onclick=()=>{$('s-cidr').value=b.dataset.use;solicitar()});return}
  res.innerHTML=`<div class="alert" role="alert">${I('error')} ${esc(d.error||'Error '+r.status)}</div>`}

async function renderJira(){
  let ev=[],je={activa:false};try{ev=await get('/api/eventos');je=await get('/api/jira/estado')}catch(e){}
  const estado=je.activa?(je.faltantes.length?`<span class="tag prod">${I('alerta')} Activa · faltan: ${esc(je.faltantes.join(', '))}</span>`:`<span class="tag dev">${I('ok')} Activa</span>`):`<span class="tag qa">${I('info')} Desactivada (simulada)</span>`;
  const linea=e=>`${new Date(e.ts).toLocaleTimeString('es-CL')}  ${e.tipo}  ${JSON.stringify(e.detalle)}`;
  $('jira').innerHTML=`<h2>Integración bidireccional con Jira ${estado}</h2>
  <div class="card"><b>Sentido 1 · IPAM ${I('flecha')} Jira</b><div class="flow"><div class="box">Panel / API<br>solicita segmento</div><span class="arrow">${I('flecha',20)}</span><div class="box">IPAM<br>valida y asigna</div><span class="arrow">${I('flecha',20)}</span><div class="box jira">Jira crea ticket<br>NET-1xx</div><span class="arrow">${I('flecha',20)}</span><div class="box">Guarda<br>ticket_jira_id</div></div>
  <span class="muted">Con la integración desactivada, el número de ticket lo genera el IPAM (secuencia NET-xxx). Al activarla (JIRA_ENABLED=true) se crea el ticket real en Jira.</span></div>
  <div class="card" style="margin-top:16px"><b>Sentido 2 · Jira ${I('flecha')} IPAM</b><div class="flow"><div class="box jira">Ticket «Solicitud de Segmento IPAM»<br>ambiente, tipo, pool, máscara, VPC</div><span class="arrow">${I('flecha',20)}</span><div class="box">Webhook<br>(firmado HMAC)</div><span class="arrow">${I('flecha',20)}</span><div class="box">IPAM calcula<br>y asigna</div><span class="arrow">${I('flecha',20)}</span><div class="box jira">Actualiza ticket<br>con el rango</div></div>
  <div class="row"><div style="flex:1;min-width:240px"><b>Simular ticket entrante</b>
   <label for="j-amb">Ambiente</label><select id="j-amb"><option>prod</option><option>qa</option><option>dev</option></select>
   <label for="j-tipo">Tipo</label><select id="j-tipo"><option>Nodos</option><option selected>Pods</option><option>Servicios</option><option>Control plane</option></select>
   <label for="j-len">Máscara</label><select id="j-len">${[16,20,22,24,28].map(n=>`<option ${n===22?'selected':''} value="${n}">/${n}</option>`).join('')}</select>
   <label for="j-vpc">VPC</label><input id="j-vpc" value="vpc-nueva"><p><button class="btn" id="j-go">Enviar webhook</button></p></div>
  <div style="flex:2;min-width:260px"><b>Registro de eventos</b><div class="log" tabindex="0" role="log" aria-label="Registro de eventos">${esc(ev.map(linea).join('\n'))||'(sin eventos)'}</div></div></div></div>`;
  if(je.simulador===false){$('j-go').parentElement.parentElement.hidden=true}
  else $('j-go').onclick=async()=>{$('j-go').disabled=true;await api('/api/jira/simular',{body:{ambiente:$('j-amb').value,tipo:$('j-tipo').value,mascara:+$('j-len').value,vpc:$('j-vpc').value.trim()||'vpc-sin-nombre'}});renderJira()}}

async function renderUsuarios(){
  try{const u=await get('/api/usuarios');
  $('usuarios').innerHTML=`<h2>Usuarios</h2><p class="muted">El rol asignado aquí rige en pocos minutos (se revalida cada 5 min), sin que la persona tenga que volver a entrar. «Heredar» usa los grupos / la configuración del proveedor.</p>
  <div class="card tablewrap" tabindex="0" role="region" aria-label="Usuarios"><table><thead><tr><th scope="col">Correo</th><th scope="col">Nombre</th><th scope="col">Último acceso</th><th scope="col">Rol asignado</th></tr></thead><tbody>
  ${u.map(x=>`<tr><td>${esc(x.email)}</td><td>${esc(x.nombre)}</td><td>${x.ultimo_acceso?new Date(x.ultimo_acceso).toLocaleString('es-CL'):'—'}</td>
  <td><select data-u="${esc(x.email)}" aria-label="Rol de ${esc(x.email)}"><option value="">Heredar</option>${['lector','solicitante','admin'].map(r=>`<option ${x.rol===r?'selected':''}>${r}</option>`).join('')}</select></td></tr>`).join('')||'<tr><td colspan="4" class="muted">Nadie ha iniciado sesión todavía.</td></tr>'}</tbody></table></div>`;
  $('usuarios').querySelectorAll('select[data-u]').forEach(s=>s.onchange=async()=>{
    const r=await api('/api/usuarios/'+encodeURIComponent(s.dataset.u),{method:'PUT',body:{rol:s.value||null}});
    if(!r.ok)alert((r.data&&r.data.error)||'No se pudo guardar');renderUsuarios()})}catch(e){fail('usuarios',e)}}
async function renderAudit(){
  try{const a=await get('/api/auditoria');
  $('audit').innerHTML=`<h2>Auditoría</h2><div class="card tablewrap" tabindex="0" role="region" aria-label="Auditoría"><table><thead><tr><th scope="col">Fecha</th><th scope="col">Usuario</th><th scope="col">Rol</th><th scope="col">Acción</th><th scope="col">Detalle</th></tr></thead><tbody>
  ${a.map(x=>`<tr><td>${new Date(x.ts).toLocaleString('es-CL')}</td><td>${esc(x.usuario)}</td><td>${esc(x.rol||'—')}</td><td>${esc(x.accion)}</td><td><code>${esc(JSON.stringify(x.detalle))}</code></td></tr>`).join('')}</tbody></table></div>`}catch(e){fail('audit',e)}}

function render(t){({pools:renderPools,asig:renderAsig,sol:renderSol,jira:renderJira,usuarios:renderUsuarios,audit:renderAudit})[t]()}

async function marca(){
  try{const m=await (await fetch('/api/config')).json();
    document.title=m.nombre+' · Gestión de segmentos';$('nombre').textContent=m.nombre+' · Gestión de segmentos';$('subtitulo').textContent=m.subtitulo||'';
    if(m.logo){$('logo').src=m.logo;$('logo').hidden=false;$('favicon').href=m.logo;$('favicon').removeAttribute('type')}$('pie').textContent=m.pie||''}catch(e){}
}
async function iniciar(){
  marca();
  const r=await fetch('/api/me',{headers:CAB});
  if(r.status===401){location.href='/login?next='+encodeURIComponent(location.pathname);return}
  YO=await r.json();
  const nav=$('nav');
  nav.querySelector('[data-t="sol"]').hidden=!puede('solicitante');
  nav.querySelector('[data-t="usuarios"]').hidden=!(puede('admin')&&YO.modo==='oidc');
  nav.querySelector('[data-t="audit"]').hidden=!puede('admin');
  $('yo').innerHTML=YO.modo==='oidc'?`${esc(YO.nombre)} · <b>${esc(YO.rol)}</b> <button type="button" id="salir">${I('salir')}Salir</button>`:(YO.modo==='none'?`<span class="tag qa">${I('alerta')} Sin autenticación (demo)</span>`:`${esc(YO.usuario)}`);
  const salir=$('salir');if(salir)salir.onclick=async()=>{const x=await api('/auth/logout',{body:{}});location.href=(x.data&&x.data.redirect)||'/'};
  show('pools');
}
iniciar();
