'use strict';
// Sirve el contrato OpenAPI 3.1 (exige sesión o token, como el resto de la API).
const { api } = require('../registro');

/** @param {import('express').Express} app @param {{contrato: object}} deps */
function montar(app, { contrato }) {
  api(app, 'get', '/openapi.json', (_q, res) => res.json(contrato));
}

module.exports = { montar };
