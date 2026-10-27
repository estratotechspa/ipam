// Página de la API: Swagger UI sobre el contrato OpenAPI que sirve el propio IPAM (sin scripts en línea: CSP estricta).
/* global SwaggerUIBundle */
window.ui = SwaggerUIBundle({
  url: '/api/v1/openapi.json',
  dom_id: '#swagger',
  deepLinking: true,
  docExpansion: 'none',
  defaultModelsExpandDepth: 0,
  displayRequestDuration: true,
  filter: true,
  validatorUrl: null, // no enviar el contrato a validadores externos
  // La sesión del navegador exige esta cabecera en las escrituras (protección CSRF); con un token Bearer no hace falta, pero no molesta.
  requestInterceptor: (req) => {
    req.headers['X-Requested-With'] = 'ipam';
    return req;
  },
});
