const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

// Cuentas locales (AUTH_LOCAL, modo Basic): el admin crea la cuenta, la persona cambia la clave temporal y entra con su rol.
const URL = 'http://127.0.0.1:8096';
const root = { username: 'root', password: 'clave-root-e2e-123' };

test('admin crea una cuenta local; la persona cambia la clave temporal y entra con su rol; el admin la desactiva', async ({ page, browser }) => {
  const usuario = `e2e-${Date.now()}`;
  await page.goto('/');
  await page.locator('#nav').getByRole('button', { name: 'Usuarios' }).click();
  await expect(page.getByRole('heading', { name: 'Usuarios', exact: true })).toBeVisible();
  await page.getByText('Nueva cuenta local').click();
  await page.fill('#us-email', usuario);
  await page.fill('#us-nombre', 'Persona de prueba');
  await page.selectOption('#us-rol', 'lector');
  await page.click('#us-crear');
  // La clave temporal se muestra una sola vez.
  const temporal = await page.locator('#ct-valor').inputValue();
  expect(temporal).toMatch(/^[A-Za-z0-9_-]{16}$/);
  await page.click('#ct-cerrar');
  const fila = page.locator('tr', { hasText: usuario });
  await expect(fila).toContainText('Local');
  await expect(fila).toContainText('clave temporal');

  // Accesibilidad de la pestaña.
  const axe = await new AxeBuilder({ page }).include('#usuarios').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`)).toEqual([]);

  // La persona entra con la clave temporal: el diálogo de cambio es obligatorio (Escape no lo cierra).
  const ctxPersona = await browser.newContext({ baseURL: URL, httpCredentials: { username: usuario, password: temporal } });
  const p = await ctxPersona.newPage();
  await p.goto('/');
  await expect(p.getByRole('heading', { name: 'Debes cambiar tu contraseña' })).toBeVisible();
  await p.keyboard.press('Escape');
  await expect(p.getByRole('heading', { name: 'Debes cambiar tu contraseña' })).toBeVisible();
  const nueva = 'una-clave-e2e-larga-1';
  await p.fill('#cc-actual', temporal);
  await p.fill('#cc-nueva', nueva);
  await p.fill('#cc-repite', 'otra-distinta-1234');
  await p.click('#cc-go');
  await expect(p.locator('#cc-msg')).toContainText('no coinciden');
  await p.fill('#cc-repite', nueva);
  await p.click('#cc-go');
  await expect(p.locator('#cc-msg')).toContainText('Contraseña cambiada');
  await ctxPersona.close();

  // Con la clave nueva entra como lector: sin Tokens ni Usuarios, con «Mi contraseña».
  const ctxNueva = await browser.newContext({ baseURL: URL, httpCredentials: { username: usuario, password: nueva } });
  const q = await ctxNueva.newPage();
  await q.goto('/');
  await expect(q.getByRole('heading', { name: 'Estado de pools' })).toBeVisible();
  await expect(q.getByRole('heading', { name: 'Debes cambiar tu contraseña' })).toHaveCount(0);
  await expect(q.locator('#nav').getByRole('button', { name: 'Usuarios' })).toHaveCount(0);
  await expect(q.locator('#nav').getByRole('button', { name: 'Tokens' })).toHaveCount(0);
  await expect(q.getByRole('button', { name: 'Mi contraseña' })).toBeVisible();
  expect((await q.request.get('/api/v1/usuarios')).status()).toBe(403);

  // El admin desactiva la cuenta: deja de entrar al instante.
  page.once('dialog', (d) => d.accept());
  await fila.getByRole('button', { name: 'Desactivar' }).click();
  await expect(page.locator('tr', { hasText: usuario })).toContainText('Desactivado');
  expect((await q.request.get('/api/v1/me')).status()).toBe(401);
  await ctxNueva.close();

  // Y se puede eliminar.
  page.once('dialog', (d) => d.accept());
  await page.locator('tr', { hasText: usuario }).getByRole('button', { name: 'Eliminar' }).click();
  await expect(page.locator('tr', { hasText: usuario })).toHaveCount(0);
  void root;
});

test('Basic: muestra usuario, rol y «Salir»; Salir llama a /auth/salir (401) y lleva a «Sesión cerrada»', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#yo')).toContainText('root');
  await expect(page.locator('#yo')).toContainText('admin');
  const salir = page.getByRole('button', { name: 'Salir', exact: true });
  await expect(salir).toBeVisible();
  const [respuesta] = await Promise.all([page.waitForResponse((r) => r.url().endsWith('/auth/salir')), salir.click()]);
  // El 401 con el desafío de Basic es lo que hace que el navegador reemplace las credenciales guardadas. Que el navegador de
  // verdad las olvide no se puede comprobar aquí (Playwright maneja las credenciales por su cuenta): se verifica a mano.
  expect(respuesta.status()).toBe(401);
  expect(respuesta.headers()['www-authenticate']).toMatch(/^Basic realm="IPAM"/);
  await expect(page).toHaveURL(/\/auth\/sesion-cerrada$/);
  await expect(page.getByRole('heading', { name: 'Sesión cerrada' })).toBeVisible();
});

test('Basic con cuentas locales: «Mi contraseña» solo en cuentas locales; el administrador de emergencia ve «Salir» pero no «Mi contraseña»', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Salir', exact: true })).toBeVisible();
  await expect(page.locator('#mi-clave')).toHaveCount(0);
});
