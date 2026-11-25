'use strict';
// Fragmentos de SQL que comparten varias consultas (constantes: nunca se arman con datos de la petición).

// Fracción del pool que ocupan los segmentos asignados (para la barra de uso de la interfaz).
const USO_POOL = `coalesce(sum(2^(32-masklen(a.cidr))),0)::float8 / (2^(32-masklen(p.cidr)))::float8`;

const COLUMNAS_DIRECCION = `d.id, host(d.ip) as ip, d.pool_id, d.asignacion_id, d.dispositivo, d.interfaz, d.rol, d.dns, d.descripcion, d.excepcion,
  d.creado_por, d.creado_en`;

module.exports = { USO_POOL, COLUMNAS_DIRECCION };
