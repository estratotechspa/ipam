'use strict';
// Cierre de sesión en modo Basic (usuario y contraseña, también con cuentas locales).
//
// Basic Auth no tiene sesión: el navegador guarda las credenciales y las reenvía solas, así que el servidor no puede
// «cerrarla». Lo que sí se puede es pedirle al navegador que las olvide: `/auth/salir` responde siempre 401 con
// `WWW-Authenticate`, y la interfaz lo llama con credenciales falsas (XMLHttpRequest con usuario y clave), lo que en
// Chromium y Firefox reemplaza las guardadas. Es un recurso de mejor esfuerzo: para cerrar del todo, cerrar el navegador.
// La ruta es pública (cuelga de /auth/), no cuenta como intento fallido y no revela nada.
const { config } = require('../../config');

const PAGINA =
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sesión cerrada</title>' +
  '<link rel="stylesheet" href="/brand.css"><body style="font:16px system-ui;margin:3rem"><h2>Sesión cerrada</h2>' +
  '<p>Tu navegador ya no recuerda tus credenciales. Si compartes este equipo, cierra también la ventana del navegador.</p>' +
  '<p><a href="/">Volver a entrar</a></p>';

/** @param {import('express').Express} app @param {{ruta: Function}} deps */
function montarBasic(app, { ruta }) {
  ruta(app, 'get', '/auth/salir', (_req, res) => {
    if (config.auth.modo !== 'basic') return res.redirect('/');
    res.status(401).set({ 'WWW-Authenticate': 'Basic realm="IPAM"', 'Cache-Control': 'no-store' }).type('html').send(PAGINA);
  });
}

module.exports = { montarBasic };
