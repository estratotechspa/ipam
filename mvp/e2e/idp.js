// Proveedor OIDC de PRUEBA para las pruebas de navegador (oidc-provider con «devInteractions»: un formulario de usuario y clave).
// Cualquier clave sirve. Roles: jefe@empresa.cl está en el grupo «ipam-admins» (admin); el resto cae en el rol por defecto (lector).
const http = require('node:http');
const PUERTO = Number(process.env.E2E_IDP_PORT || 8098);
const APP = process.env.E2E_OIDC_APP_URL || 'http://127.0.0.1:8097';
const GRUPOS = { 'jefe@empresa.cl': ['ipam-admins'] };

(async () => {
  const { default: Provider } = await import('oidc-provider');
  const provider = new Provider(`http://127.0.0.1:${PUERTO}`, {
    clients: [
      { client_id: 'ipam', client_secret: 's3cret', redirect_uris: [`${APP}/auth/callback`], grant_types: ['authorization_code'], response_types: ['code'] },
    ],
    findAccount: async (_c, id) => ({
      accountId: id,
      claims: async () => ({ sub: id, email: id, email_verified: true, name: id.split('@')[0], groups: GRUPOS[id] || [] }),
    }),
    claims: { openid: ['sub'], email: ['email', 'email_verified'], profile: ['name'], groups: ['groups'] },
    conformIdTokenClaims: false,
    features: { devInteractions: { enabled: true } },
  });
  http.createServer(provider.callback()).listen(PUERTO, '127.0.0.1', () => console.log(`IdP de prueba en :${PUERTO}`));
})();
