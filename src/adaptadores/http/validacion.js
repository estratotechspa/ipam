'use strict';
// Validación de entrada generada a partir del contrato OpenAPI: los esquemas de `components.schemas` se compilan con Ajv,
// así lo que documenta el contrato y lo que realmente se acepta no pueden divergir. Solo valida FORMA (tipos, campos requeridos,
// campos desconocidos); las reglas de negocio (rangos, TTL, solapes…) siguen en el dominio con sus códigos de error propios.
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const contexto = require('./contexto');

const TIPOS = {
  string: 'texto',
  integer: 'un número entero',
  number: 'un número',
  boolean: 'verdadero o falso',
  object: 'un objeto',
  array: 'una lista',
  null: 'nulo',
};

/** Traduce un error de Ajv a una frase en español. */
function traducir(e) {
  const campo = e.instancePath || '/';
  const p = e.params || {};
  switch (e.keyword) {
    case 'type':
      return {
        campo,
        mensaje: `debe ser ${[]
          .concat(p.type)
          .map((t) => TIPOS[t] || t)
          .join(' o ')}`,
      };
    case 'required':
      return { campo: `${campo === '/' ? '' : campo}/${p.missingProperty}`, mensaje: 'es obligatorio' };
    case 'additionalProperties':
      return { campo: `${campo === '/' ? '' : campo}/${p.additionalProperty}`, mensaje: 'campo no permitido' };
    case 'enum':
      return { campo, mensaje: `debe ser uno de: ${p.allowedValues.join(', ')}` };
    case 'const':
      return { campo, mensaje: `debe ser ${JSON.stringify(p.allowedValue)}` };
    case 'pattern':
      return { campo, mensaje: 'no tiene el formato esperado' };
    case 'format':
      return { campo, mensaje: `no es un valor válido (${p.format})` };
    case 'maxLength':
      return { campo, mensaje: `no puede superar ${p.limit} caracteres` };
    case 'minLength':
      return { campo, mensaje: `debe tener al menos ${p.limit} caracteres` };
    case 'minimum':
      return { campo, mensaje: `debe ser al menos ${p.limit}` };
    case 'maximum':
      return { campo, mensaje: `no puede superar ${p.limit}` };
    default:
      return { campo, mensaje: e.message || 'no es válido' };
  }
}

/** @param {object} documentoOpenApi */
function crearValidador(documentoOpenApi) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ ...documentoOpenApi, $id: 'openapi' });
  const cache = new Map();
  const compilar = (nombre) => {
    if (!cache.has(nombre)) {
      const v = ajv.getSchema(`openapi#/components/schemas/${nombre}`);
      if (!v) throw new Error(`El contrato no define el esquema «${nombre}»`);
      cache.set(nombre, v);
    }
    return cache.get(nombre);
  };
  return {
    /** Valida un valor contra un esquema del contrato. Devuelve {ok, errores}. */
    validar(nombre, valor) {
      const v = compilar(nombre);
      return v(valor) ? { ok: true, errores: [] } : { ok: false, errores: (v.errors || []).map(traducir) };
    },
    /** Middleware: valida req.body contra el esquema. Un cuerpo ausente se trata como `{}` si `opcional` y como error si no. */
    cuerpo(nombre, { opcional = false } = {}) {
      compilar(nombre); // falla al arrancar si el contrato no tiene el esquema
      return (req, res, next) => {
        let valor = req.body;
        if (valor === undefined) {
          if (!opcional)
            return res
              .status(400)
              .json({ error: 'validacion', mensaje: 'Falta el cuerpo JSON de la petición.', detalles: [], request_id: contexto.actual().request_id });
          valor = {};
        }
        const r = this.validar(nombre, valor);
        if (r.ok) return next();
        return res
          .status(400)
          .json({ error: 'validacion', mensaje: 'El cuerpo no cumple el contrato.', detalles: r.errores, request_id: contexto.actual().request_id });
      };
    },
    ajv,
  };
}

module.exports = { crearValidador, traducir };
