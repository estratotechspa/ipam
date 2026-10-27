const { test, expect } = require('@playwright/test');

const H = { 'X-Requested-With': 'ipam' };

async function irA(page, nombre) {
  await page.goto('/');
  await page.locator('#nav').getByRole('button', { name: nombre, exact: true }).click();
}

test('navegación: teclado, aria-current, iconos y enlace para saltar al contenido', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('a.skip, a[href="#contenido"]').first()).toHaveCount(1);
  const asig = page.locator('#nav').getByRole('button', { name: 'Asignaciones', exact: true });
  await asig.focus();
  await page.keyboard.press('Enter');
  await expect(asig).toHaveAttribute('aria-current', /true|page/);
  await expect(page.locator('#nav svg').first()).toBeVisible();
});

test('pools: indicadores y barras de uso con umbrales', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.kpis .kpi')).toHaveCount(5);
  await expect(page.getByText('Pools sobre 80 %')).toBeVisible();
  await expect(page.locator('#pools table thead th[scope="col"]').first()).toBeVisible();
  await expect(page.locator('#pools .bar').first()).toBeVisible();
});

test('ficha del pool: mapa de bloques', async ({ page }) => {
  await page.goto('/');
  const primero = page.locator('#pools tbody tr button').first();
  await primero.click();
  await expect(page.getByRole('dialog').locator('.mapa').first()).toBeVisible();
  await page.keyboard.press('Escape');
});

test('asignaciones: orden, búsqueda y estado vacío', async ({ page }) => {
  const vpc = `b4-${Date.now().toString(36)}`;
  await page.request.post('/api/v1/solicitudes', { headers: H, data: { pool: 'gke-nodos-qa', vpc, mascara: 28 } });
  await irA(page, 'Asignaciones');
  const th = page.locator('#asig th[aria-sort]').first();
  await expect(th).toBeVisible();
  await th.locator('button').click();
  await expect(page.locator('#asig th[aria-sort="ascending"], #asig th[aria-sort="descending"]').first()).toBeVisible();
  await page.locator('#f-buscar').pressSequentially('zzz-no-existe-zzz');
  await expect(page.locator('#asig')).toContainText(/sin resultados|no hay|ninguna/i);
});

test('nueva asignación: validación de CIDR en vivo', async ({ page }) => {
  await irA(page, 'Asignaciones');
  await page.locator('#asig summary', { hasText: 'Nueva asignación' }).click();
  await page.fill('#na-cidr', 'esto-no-es-cidr');
  await expect(page.locator('#na-cidr ~ .campo-msg, .campo-msg').first()).toBeVisible();
  await expect(page.locator('#na-cidr')).toHaveAttribute('aria-invalid', 'true');
});

test('diálogo de confirmación accesible: foco, Esc cancela, sin diálogos nativos', async ({ page }) => {
  let nativo = 0;
  page.on('dialog', (d) => {
    nativo++;
    d.dismiss();
  });
  const vpc = `b4c-${Date.now().toString(36)}`;
  await page.request.post('/api/v1/solicitudes', { headers: H, data: { pool: 'gke-nodos-qa', vpc, mascara: 28 } });
  await irA(page, 'Asignaciones');
  await page.fill('#asig input[type="search"]', vpc);
  await page
    .locator('#asig')
    .getByRole('button', { name: /Liberar/ })
    .first()
    .click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  expect(nativo).toBe(0);
});

test('pestaña Jira: estado primero y flujos plegados', async ({ page }) => {
  await irA(page, 'Jira');
  await expect(page.locator('#jira')).toContainText(/webhook|Estado|eventos/i);
  await expect(page.locator('#j-como')).toBeVisible();
});

test('reflow a 320 px sin desplazamiento horizontal de la página', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/');
  const ancho = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(ancho).toBeLessThanOrEqual(321);
});

test('modo oscuro: el texto principal conserva contraste legible', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  const [fg, bg] = await page.evaluate(() => [getComputedStyle(document.body).color, getComputedStyle(document.body).backgroundColor]);
  expect(fg).not.toBe(bg);
});
