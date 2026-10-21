const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'e2e',
  timeout: 30000,
  use: { baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:8099', acceptDownloads: true,
    httpCredentials: process.env.E2E_USER ? { username: process.env.E2E_USER, password: process.env.E2E_PASS } : undefined },
  // Si no se indica E2E_BASE_URL, levanta la app (requiere DATABASE_URL con esquema y datos de ejemplo).
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'node src/server.js', url: 'http://127.0.0.1:8099/api/health', env: { PORT: '8099' }, reuseExistingServer: !process.env.CI,
  },
});
