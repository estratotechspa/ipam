// @ts-check
'use strict';
// Tabla «ambiente + uso → pool»: qué pool corresponde a nodos, pods y servicios en cada ambiente. Solo un admin la cambia (lo exige la ruta).
const { ok, fallo } = require('./resultado');

const { AMBIENTES, normalizarAmbiente } = require('../dominio/ambiente');
const USOS = ['nodos', 'pods', 'servicios'];
const malo = (error, mensaje) => fallo('validacion', error, { mensaje });

/** @param {{repo: any}} deps */
function crearPoolUso({ repo }) {
  const validarClave = (ambiente, uso) =>
    !AMBIENTES.includes(ambiente)
      ? malo('ambiente_invalido', `El ambiente debe ser uno de: ${AMBIENTES.join(', ')} (prd = prod).`)
      : !USOS.includes(uso)
        ? malo('uso_invalido', `El uso debe ser uno de: ${USOS.join(', ')}.`)
        : null;

  async function listar() {
    return ok({ filas: await repo.listarPoolUso() });
  }
  async function guardar(ambienteEntrada, uso, poolId) {
    const ambiente = normalizarAmbiente(ambienteEntrada);
    const v = validarClave(ambiente, uso);
    if (v) return v;
    const pool = typeof poolId === 'string' ? await repo.obtenerPool(poolId) : null;
    if (!pool) return fallo('no_encontrado', 'pool_no_existe', { mensaje: `El pool «${poolId}» no existe.` });
    if (pool.ambiente !== ambiente) return malo('pool_de_otro_ambiente', `El pool ${pool.id} es de ${pool.ambiente}, no de ${ambiente}.`);
    return ok({ fila: await repo.guardarPoolUso(ambiente, uso, pool.id) });
  }
  async function borrar(ambienteEntrada, uso) {
    const ambiente = normalizarAmbiente(ambienteEntrada);
    const v = validarClave(ambiente, uso);
    if (v) return v;
    return (await repo.borrarPoolUso(ambiente, uso)) ? ok({}) : fallo('no_encontrado', 'no_encontrado', { mensaje: 'Ese uso no tiene pool configurado.' });
  }
  return { listar, guardar, borrar };
}

module.exports = { crearPoolUso };
