const { defineConfig } = require('@playwright/test');

// Tres procesos: la app abierta (modo de demostración), un proveedor OIDC de prueba y la app con login OIDC.
// Requiere DATABASE_URL con el esquema y los datos de ejemplo aplicados. Con E2E_BASE_URL se prueba una instancia ya levantada (solo proyecto «abierto»).
const LIMITES = {
  RATE_LIMIT_POR_MINUTO: '100000',
  RATE_LIMIT_ESCRITURA_POR_MINUTO: '100000',
  RATE_LIMIT_IP_POR_MINUTO: '100000',
  RATE_LIMIT_AUTH_FALLOS_POR_MINUTO: '100000',
};
const credenciales = process.env.E2E_USER ? { username: process.env.E2E_USER, password: process.env.E2E_PASS } : undefined;
const externo = !!process.env.E2E_BASE_URL;

module.exports = defineConfig({
  testDir: 'e2e',
  timeout: 30000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { acceptDownloads: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    {
      name: 'abierto',
      testMatch: /(flujo|reservas-tokens|xss)\.spec\.js/,
      use: { baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:8099', httpCredentials: credenciales },
    },
    ...(externo ? [] : [{ name: 'oidc', testMatch: /oidc\.spec\.js/, use: { baseURL: 'http://127.0.0.1:8097' } }]),
  ],
  webServer: externo
    ? undefined
    : [
        { command: 'node src/server.js', url: 'http://127.0.0.1:8099/healthz', env: { PORT: '8099', ...LIMITES }, reuseExistingServer: !process.env.CI },
        { command: 'node e2e/idp.js', url: 'http://127.0.0.1:8098/.well-known/openid-configuration', reuseExistingServer: !process.env.CI },
        {
          command: 'node src/server.js',
          url: 'http://127.0.0.1:8097/healthz',
          reuseExistingServer: !process.env.CI,
          env: {
            PORT: '8097',
            ...LIMITES,
            OIDC_ISSUER: 'http://127.0.0.1:8098',
            OIDC_CLIENT_ID: 'ipam',
            OIDC_CLIENT_SECRET: 's3cret',
            PUBLIC_URL: 'http://127.0.0.1:8097',
            SESSION_SECRET: 'e2e-sesion-secreto-solo-para-pruebas-0123456789',
            OIDC_ALLOW_INSECURE: 'true',
            OIDC_SCOPES: 'openid email profile groups',
            OIDC_ADMIN_GROUPS: 'ipam-admins',
            OIDC_ALLOWED_DOMAINS: 'empresa.cl',
            OIDC_DEFAULT_ROLE: 'lector',
          },
        },
      ],
});
