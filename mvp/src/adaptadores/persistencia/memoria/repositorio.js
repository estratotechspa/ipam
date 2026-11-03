'use strict';
// Repositorio EN MEMORIA: implementa el mismo puerto que el de PostgreSQL, pero solo para pruebas de los casos de uso
// (rápidas, sin base de datos) y para demostrar que la aplicación no depende de PostgreSQL. NO es para producción:
// no hay persistencia ni aislamiento real entre transacciones.
const crypto = require('node:crypto');
const { parse, overlap } = require('../../../dominio/cidr');
const { ConflictoDeDatos } = require('../../../aplicacion/resultado');
const { SOLICITANTE_JIRA } = require('../../../dominio/reserva');

/** @param {{reloj?: {ahora: () => Date}, pools?: any[]}} [o] */
function crearRepositorioMemoria({ reloj = { ahora: () => new Date() }, pools = [] } = {}) {
  const datos = {
    pools: new Map(pools.map((p) => [p.id, p])),
    asignaciones: [],
    reservas: [],
    tokens: [],
    poolUso: new Map(),
    ticket: 142,
    idAsignacion: 0,
    barredor: null,
  };
  const ahora = () => reloj.ahora();
  const efectivo = (r) => (r.estado === 'reservada' && r.expira_en.getTime() <= ahora().getTime() ? 'expirada' : r.estado);
  const vigente = (r) => r.estado === 'reservada' && r.expira_en.getTime() > ahora().getTime();
  const vista = (r) =>
    r && {
      ...r,
      estado: efectivo(r),
      estado_registrado: r.estado,
      segundos_restantes: vigente(r) ? Math.floor((r.expira_en.getTime() - ahora().getTime()) / 1000) : 0,
    };
  const cruza = (a, b) => overlap(/** @type {any} */ (parse(a)), /** @type {any} */ (parse(b)));

  const metodos = {
    async bloquear() {},
    async obtenerPool(id) {
      return datos.pools.get(id);
    },
    async buscarPools({ ambiente, tipo }) {
      return [...datos.pools.values()].filter((p) => p.ambiente === ambiente && p.tipo === tipo).sort((a, b) => a.id.localeCompare(b.id));
    },
    async ocupados(poolId) {
      return [...datos.asignaciones.filter((a) => a.pool_id === poolId), ...datos.reservas.filter((r) => r.pool_id === poolId && vigente(r))].map(
        (x) => x.cidr,
      );
    },
    async conflicto(poolId, cidr) {
      const a = datos.asignaciones.find((x) => x.pool_id === poolId && cruza(x.cidr, cidr));
      if (a) return { fuente: 'asignacion', cidr: a.cidr, vpc: a.vpc, solicitante: a.solicitante, ticket: a.ticket, creado_en: a.creado_en };
      const r = datos.reservas.find((x) => x.pool_id === poolId && vigente(x) && cruza(x.cidr, cidr));
      return r
        ? { fuente: 'reserva', cidr: r.cidr, vpc: r.vpc, solicitante: r.solicitante, ticket: r.ticket, creado_en: r.creado_en, expira_en: r.expira_en }
        : null;
    },
    async siguienteTicket() {
      datos.ticket += 1;
      return `NET-${datos.ticket}`;
    },
    async insertarAsignacion({
      pool,
      cidr,
      vpc,
      solicitante,
      ticket,
      origen,
      vlan = null,
      vlan_nombre = null,
      proyecto = null,
      subred = null,
      grupo = null,
      rango = null,
      nombre = null,
    }) {
      if (datos.asignaciones.some((x) => x.pool_id === pool && cruza(x.cidr, cidr))) throw new ConflictoDeDatos('solapamiento', '23P01');
      const id = ++datos.idAsignacion;
      const a = {
        id,
        codigo: `ASG-${String(id).padStart(6, '0')}`,
        pool_id: pool,
        cidr,
        vpc,
        vlan,
        vlan_nombre,
        proyecto,
        subred,
        grupo,
        rango,
        nombre,
        solicitante,
        ticket,
        origen,
        creado_en: ahora(),
      };
      datos.asignaciones.push(a);
      return { ...a };
    },
    async asignacionPorId(id) {
      return datos.asignaciones.find((a) => String(a.id) === String(id)) || null;
    },
    async reservaPorClave(solicitante, clave) {
      return vista(datos.reservas.find((r) => r.solicitante === solicitante && r.clave_idem === clave)) || null;
    },
    async reservaPorId(id) {
      return vista(datos.reservas.find((r) => r.id === id)) || null;
    },
    async listarReservas({ estado, pool, solicitante, limite }) {
      return datos.reservas
        .map(vista)
        .filter((r) => (!estado || r.estado === estado) && (!pool || r.pool_id === pool) && (!solicitante || r.solicitante === solicitante))
        .sort((a, b) => b.creado_en - a.creado_en)
        .slice(0, limite);
    },
    async contarVigentesDe(solicitante) {
      return datos.reservas.filter((r) => r.solicitante === solicitante && vigente(r)).length;
    },
    async insertarReserva({
      pool,
      cidr,
      vpc,
      solicitante,
      ticket,
      ttlHoras,
      clave,
      vlan = null,
      vlan_nombre = null,
      proyecto = null,
      subred = null,
      grupo = null,
      rango = null,
      nombre = null,
      expiraEn = null,
    }) {
      if (clave && datos.reservas.some((r) => r.solicitante === solicitante && r.clave_idem === clave)) throw new ConflictoDeDatos('clave repetida', '23505');
      if (
        datos.reservas.some((r) => r.pool_id === pool && vigente(r) && cruza(r.cidr, cidr)) ||
        datos.asignaciones.some((a) => a.pool_id === pool && cruza(a.cidr, cidr))
      )
        throw new ConflictoDeDatos('solapamiento', '23P01');
      const r = {
        id: crypto.randomUUID(),
        pool_id: pool,
        cidr,
        vpc,
        vlan,
        vlan_nombre,
        proyecto,
        subred,
        grupo,
        rango,
        nombre,
        solicitante,
        ticket,
        estado: 'reservada',
        clave_idem: clave,
        creado_en: ahora(),
        expira_en: expiraEn ? new Date(expiraEn) : new Date(ahora().getTime() + ttlHoras * 3600_000),
        resuelto_en: null,
        asignacion_id: null,
      };
      datos.reservas.push(r);
      return vista(r);
    },
    async reservasDeGrupo(grupo) {
      const peso = (r) => (r.rango === 'principal' ? 0 : r.rango === 'pods' ? 1 : 2);
      return datos.reservas
        .filter((r) => r.grupo === grupo)
        .sort((a, b) => peso(a) - peso(b) || a.cidr.localeCompare(b.cidr))
        .map(vista);
    },
    async versionPoolUso() {
      return [...datos.poolUso.values()]
        .sort((a, b) => (a.ambiente + a.uso).localeCompare(b.ambiente + b.uso))
        .map((f) => `${f.ambiente}/${f.uso}=${f.pool_id}`)
        .join(',');
    },
    async datosRenovacionGrupo(grupo, horas, maxHoras) {
      const filas = datos.reservas.filter((r) => r.grupo === grupo);
      const creado = new Date(Math.min(...filas.map((r) => r.creado_en.getTime())));
      return {
        creado_en: creado,
        ahora: ahora(),
        nueva: new Date(ahora().getTime() + horas * 3600_000),
        tope: new Date(creado.getTime() + maxHoras * 3600_000),
      };
    },
    async extenderGrupo(grupo, nueva) {
      let n = 0;
      for (const r of datos.reservas.filter((x) => x.grupo === grupo && vigente(x))) {
        if (new Date(nueva) > r.expira_en) r.expira_en = new Date(nueva);
        n += 1;
      }
      return n;
    },
    async gruposDe({ clave = null, ticket = null, solicitante = null, limite = 100 }) {
      const ids = new Map();
      for (const r of datos.reservas) {
        if (!r.grupo) continue;
        if (clave && !(r.solicitante === solicitante && String(r.clave_idem || '').startsWith(clave + ':'))) continue;
        if (solicitante && r.solicitante !== solicitante) continue;
        if (ticket && r.ticket !== ticket) continue;
        ids.set(r.grupo, Math.min(ids.get(r.grupo) ?? Infinity, r.creado_en.getTime()));
      }
      return [...ids.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limite)
        .map(([g]) => g);
    },
    async nuevoGrupo() {
      return crypto.randomUUID();
    },
    async listarPoolUso() {
      return [...datos.poolUso.values()].sort((a, b) => (a.ambiente + a.uso).localeCompare(b.ambiente + b.uso));
    },
    async obtenerPoolUso(ambiente, uso) {
      return datos.poolUso.get(`${ambiente}/${uso}`) || null;
    },
    async guardarPoolUso(ambiente, uso, poolId) {
      const fila = { ambiente, uso, pool_id: poolId };
      datos.poolUso.set(`${ambiente}/${uso}`, fila);
      return fila;
    },
    async borrarPoolUso(ambiente, uso) {
      return datos.poolUso.delete(`${ambiente}/${uso}`);
    },
    async expirarVencidas(poolId) {
      const out = [];
      for (const r of datos.reservas) {
        if (r.estado === 'reservada' && r.expira_en.getTime() <= ahora().getTime() && (!poolId || r.pool_id === poolId)) {
          r.estado = 'expirada';
          r.resuelto_en = ahora();
          out.push({ id: r.id, cidr: r.cidr, pool_id: r.pool_id, solicitante: r.solicitante });
        }
      }
      return out;
    },
    async marcarExpirada(id) {
      const r = datos.reservas.find((x) => x.id === id && x.estado === 'reservada');
      if (!r) return undefined;
      r.estado = 'expirada';
      r.resuelto_en = ahora();
      return { id: r.id, cidr: r.cidr, pool_id: r.pool_id, solicitante: r.solicitante };
    },
    async marcarConfirmada(id, asignacionId) {
      const r = datos.reservas.find((x) => x.id === id);
      Object.assign(r, { estado: 'confirmada', resuelto_en: ahora(), asignacion_id: asignacionId });
      return vista(r);
    },
    async marcarLiberada(id) {
      const r = datos.reservas.find((x) => x.id === id);
      Object.assign(r, { estado: 'liberada', resuelto_en: ahora() });
      return vista(r);
    },
    async borrarAsignacion(id) {
      const n = datos.asignaciones.length;
      datos.asignaciones = datos.asignaciones.filter((a) => String(a.id) !== String(id));
      return datos.asignaciones.length < n;
    },
    async insertarAsignacionDeReserva(r) {
      return metodos.insertarAsignacion({
        pool: r.pool_id,
        cidr: r.cidr,
        vpc: r.vpc,
        solicitante: r.solicitante,
        ticket: r.ticket,
        origen: r.solicitante === SOLICITANTE_JIRA ? 'jira' : 'agente',
        vlan: r.vlan ?? null,
        vlan_nombre: r.vlan_nombre ?? null,
        proyecto: r.proyecto ?? null,
        subred: r.subred ?? null,
        grupo: r.grupo ?? null,
        rango: r.rango ?? null,
        nombre: r.nombre ?? null,
      });
    },
    async purgarLimite() {
      return 0;
    },
  };
  const estadoToken = (t) => (t.revocado_en ? 'revocado' : t.expira_en.getTime() <= ahora().getTime() ? 'vencido' : 'activo');
  const vistaToken = (t) =>
    t && {
      ...t,
      hash: undefined,
      estado: estadoToken(t),
      por_vencer: estadoToken(t) === 'activo' && t.expira_en.getTime() - ahora().getTime() < 7 * 86400_000,
    };
  const tokens = {
    async insertarToken({ nombre, prefijo, hash, rol, cuota, creadoPor, dias, alcance = null }) {
      if (datos.tokens.some((t) => t.nombre === nombre || t.hash === hash)) throw new ConflictoDeDatos('nombre repetido', '23505');
      const t = {
        id: crypto.randomUUID(),
        nombre,
        prefijo,
        hash,
        rol,
        cuota_reservas: cuota,
        alcance,
        creado_por: creadoPor,
        creado_en: ahora(),
        expira_en: new Date(ahora().getTime() + dias * 86400_000),
        ultimo_uso: null,
        revocado_en: null,
      };
      datos.tokens.push(t);
      return vistaToken(t);
    },
    async listarTokens() {
      return [...datos.tokens].reverse().map(vistaToken);
    },
    async tokenPorHash(hash) {
      return vistaToken(datos.tokens.find((t) => t.hash === hash)) || null;
    },
    async revocarToken(id) {
      const t = datos.tokens.find((x) => x.id === id);
      if (!t) return null;
      t.revocado_en = t.revocado_en || ahora();
      return vistaToken(t);
    },
    async tocarUltimoUso(id) {
      const t = datos.tokens.find((x) => x.id === id);
      if (t && (!t.ultimo_uso || ahora().getTime() - t.ultimo_uso.getTime() > 60_000)) t.ultimo_uso = ahora();
    },
  };
  return {
    ...metodos,
    ...tokens,
    datos,
    async transaccion(fn) {
      return fn(metodos);
    },
    async liberarAsignacion(id) {
      const a = datos.asignaciones.find((x) => String(x.id) === String(id));
      if (!a) return null;
      datos.asignaciones = datos.asignaciones.filter((x) => x !== a);
      return { cidr: a.cidr, ticket: a.ticket, pool_id: a.pool_id };
    },
    async actualizarTicketAsignacion(id, ticket) {
      const a = datos.asignaciones.find((x) => String(x.id) === String(id));
      if (a) a.ticket = ticket;
    },
    async conBarredor({ minimoMs }, fn) {
      if (datos.barredor && ahora().getTime() - datos.barredor.getTime() < minimoMs) return { ejecutado: false, motivo: 'reciente' };
      const r = await fn(metodos);
      datos.barredor = ahora();
      return { ejecutado: true, ...r };
    },
  };
}

module.exports = { crearRepositorioMemoria };
