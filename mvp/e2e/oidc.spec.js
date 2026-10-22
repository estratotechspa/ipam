const { test, expect } = require('@playwright/test');

// Login real con un proveedor OIDC de prueba (e2e/idp.js). Verifica que la interfaz respeta el rol.
async function entrar(page, email) {
  await page.goto('/');
  await page.waitForURL(/127\.0\.0\.1:8098\/interaction\//);
  await page.fill('input[name="login"]', email);
  await page.fill('input[name="password"]', 'cualquiera');
  await page.click('button[type="submit"]');
  // Pantalla de consentimiento del proveedor de prueba.
  await page.waitForURL(/127\.0\.0\.1:8098\/interaction\/.*(confirm|consent)?/);
  await page.click('button[type="submit"]');
  await page.waitForURL('http://127.0.0.1:8097/');
  await expect(page.getByRole('heading', { name: 'Estado de pools' })).toBeVisible();
}

test('un lector NO ve la pestaña Tokens (ni Auditoría), ve Reservas y no puede operar; la API también lo impide', async ({ page }) => {
  await entrar(page, 'lector@empresa.cl');
  const nav = page.locator('#nav');
  await expect(nav.getByRole('button', { name: 'Reservas' })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Tokens' })).toHaveCount(0);
  await expect(nav.getByRole('button', { name: 'Auditoría' })).toHaveCount(0);
  await nav.getByRole('button', { name: 'Asignaciones' }).click();
  await expect(page.getByText('Nueva asignación')).toHaveCount(0); // asignar directo es solo de admin
  await expect(page.getByRole('button', { name: /Importar segmentos/ })).toHaveCount(0);
  await nav.getByRole('button', { name: 'Reservas' }).click();
  await expect(page.getByRole('heading', { name: 'Reservas', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Confirmar|Liberar)/ })).toHaveCount(0);
  const r = await page.request.post('/api/v1/tokens', { headers: { 'X-Requested-With': 'ipam' }, data: { nombre: 'intruso', rol: 'agente' } });
  expect(r.status()).toBe(403);
  expect((await page.request.get('/api/v1/tokens')).status()).toBe(403);
});

test('un administrador ve la pestaña Tokens y la lista de tokens', async ({ page }) => {
  await entrar(page, 'jefe@empresa.cl');
  const nav = page.locator('#nav');
  await expect(nav.getByRole('button', { name: 'Tokens' })).toBeVisible();
  await nav.getByRole('button', { name: 'Tokens' }).click();
  await expect(page.getByRole('heading', { name: 'Tokens de servicio' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Crear token' })).toBeVisible();
  expect((await page.request.get('/api/v1/tokens')).status()).toBe(200);
});
