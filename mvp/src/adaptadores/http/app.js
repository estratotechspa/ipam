'use strict';
// Adaptador HTTP: arma la aplicación Express. Orden de middleware:
//  correlación y log → cabeceras de seguridad → cuerpo JSON → sondas y rutas públicas → acceso → rutas de negocio → estáticos → errores.
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const { crearSolicitud } = require('./middleware/solicitud');
const { crearAcceso } = require('../auth/acceso');
const { montarOidc } = require('../auth/oidc');
const { manejadorDeErrores, noEncontrada } = require('./errores');
const { ruta } = require('./registro');
const marca = require('./marca');
const sistema = require('./rutas/sistema');
const asignacionesRutas = require('./rutas/asignaciones');
const administracionRutas = require('./rutas/administracion');
const jiraRutas = require('./rutas/jira');
const reservasRutas = require('./rutas/reservas');
const tokensRutas = require('./rutas/tokens');
const contratoRutas = require('./rutas/contrato');
const metricasRutas = require('./rutas/metricas');
const { construirOpenApi } = require('../../openapi');
const { crearValidador } = require('./validacion');
const { crearMiddlewareLimite } = require('./middleware/limite');

const RUTAS_IMPORTAR = new Set(['/api/importar', '/api/v1/importar']);

/**
 * @param {{config: any, log: any, db: any, repo: any, casos: any, auditar: Function, publicador: any, tickets: any,
 *          estado: {apagando: boolean}, metricas: any, trazas: any}} deps
 */
function crearApp(deps) {
  const { config, log, db, repo, casos, auditar, publicador, tickets, estado, metricas, trazas, limite } = deps;
  const app = express();
  app.disable('x-powered-by');
  // Detrás de un balanceador: TRUST_PROXY = número de saltos. Así req.ip, req.secure y el rate limit usan los datos reales del cliente.
  if (config.http.trustProxy !== undefined) app.set('trust proxy', config.http.trustProxy);

  app.use(crearSolicitud({ log, metricas, trazas }));

  // Cabeceras de seguridad. La interfaz no usa scripts en línea (todo en /app.js); los estilos en atributo sí.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: null, // el TLS lo termina el balanceador; no forzar https desde la app
        },
      },
      hsts: config.http.hsts,
    }),
  );

  // Las respuestas de la API nunca se guardan en cachés intermedias ni del navegador (pueden traer datos sensibles, p. ej. un token recién creado).
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });

  // Cuerpo JSON: límite pequeño por defecto; solo la importación de respaldos admite uno grande. `raw` sirve para verificar firmas.
  const guardarRaw = (req, _res, buf) => {
    req.raw = buf;
  };
  const jsonNormal = express.json({ limit: config.http.jsonLimite, verify: guardarRaw });
  const jsonGrande = express.json({ limit: config.http.jsonLimiteImportar, verify: guardarRaw });
  app.use((req, res, next) => (RUTAS_IMPORTAR.has(req.path) ? jsonGrande : jsonNormal)(req, res, next));

  // Públicas (no exigen sesión): sondas, marca, /auth.
  sistema.montar(app, { db, estado, log });
  metricasRutas.montar(app, { metricas });
  marca.montar(app);
  montarOidc(app, { repo, auditar, ruta });

  app.use(
    crearAcceso({
      rechazo: (motivo) => metricas.authRechazo(motivo),
      autenticarToken: (t) => casos.tokens.autenticar(t),
      auditar,
      usuariosLocales: { buscar: (e) => repo.usuarioPorEmail(e), marcarAcceso: (e) => repo.marcarAcceso(e) },
      frenoFuerzaBruta: { bloqueada: (ip) => limite.bloqueadaPorFallos(ip), fallo: (ip) => limite.registrarFallo(ip) },
    }),
  );
  app.use((req, _res, next) => {
    if (req.actor) require('./contexto').actual().actor = req.actor.nombre;
    next();
  });
  app.use(crearMiddlewareLimite({ limite }));

  const audita = (req, accion, detalle) => auditar(accion, req.usuario || 'sistema', req.rol || null, detalle, req.ip);
  sistema.montarSesion(app);
  const contrato = construirOpenApi({ servidor: config.http.publicUrl || '/' });
  const validacion = crearValidador(contrato);
  const dep = { casos, audita, tickets, publicador, config, contrato, validacion };
  asignacionesRutas.montar(app, dep);
  administracionRutas.montar(app, dep);
  jiraRutas.montar(app, dep);
  reservasRutas.montar(app, dep);
  tokensRutas.montar(app, dep);
  contratoRutas.montar(app, dep);

  app.use(express.static(path.join(__dirname, '..', '..', '..', 'public')));
  app.use(noEncontrada);
  app.use(manejadorDeErrores(log));
  return app;
}

module.exports = { crearApp };
