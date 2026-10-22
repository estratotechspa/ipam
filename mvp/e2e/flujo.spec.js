const { test, expect } = require('@playwright/test');

test('solicitar → ver en asignaciones → exportar a Excel → liberar', async ({ page }) => {
  const vpc = `e2e-${Date.now()}`;
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Estado de pools' })).toBeVisible();

  await page.getByRole('button', { name: 'Asignar directo', exact: true }).click();
  await page.selectOption('#s-pool', 'gke-nodos-qa');
  await page.fill('#s-vpc', vpc);
  await page.fill('#s-cidr', '');
  await page.selectOption('#s-len', '24');
  await page.click('#s-go');
  await expect(page.locator('#s-res .ok')).toContainText('Asignado');

  await page.getByRole('button', { name: 'Asignaciones' }).click();
  const fila = page.locator('tr', { hasText: vpc });
  await expect(fila).toBeVisible();

  const [descarga] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: /Exportar a Excel/ }).click()]);
  expect(descarga.suggestedFilename()).toMatch(/^ipam-segmentos-\d{4}-\d{2}-\d{2}\.xlsx$/);

  page.once('dialog', (d) => d.accept('prueba e2e: ya no se necesita'));
  await fila.getByRole('button', { name: 'Liberar' }).click();
  await expect(page.locator('tr', { hasText: vpc })).toHaveCount(0);
  // El motivo queda en la auditoría.
  const aud = await (await page.request.get('/api/v1/auditoria')).json();
  expect(aud.some((f) => f.accion === 'liberar' && f.detalle.motivo === 'prueba e2e: ya no se necesita')).toBe(true);
});

test('un CIDR solapado muestra la alerta y sugiere segmentos libres', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Asignar directo', exact: true }).click();
  await page.selectOption('#s-pool', 'gke-pods-prod');
  await page.fill('#s-vpc', 'vpc-e2e-solapado');
  await page.fill('#s-cidr', '10.64.8.0/22');
  await page.click('#s-go');
  await expect(page.locator('#s-res .alert')).toContainText('Solapamiento detectado');
  await expect(page.locator('#s-res .sug').first()).toBeVisible();
});

test('el filtro por ambiente y proveedor acota Pools, Asignaciones y Reservas', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Estado de pools' })).toBeVisible();
  const filas = page.locator('#pools tbody tr').filter({ has: page.locator('td') });
  const total = await filas.count();
  expect(total).toBeGreaterThan(1);
  await page.selectOption('#pools #f-ambiente', 'prod');
  await expect(page.locator('#pools #f-ambiente')).toBeFocused();
  const prod = await filas.count();
  expect(prod).toBeGreaterThan(0);
  expect(prod).toBeLessThan(total);
  for (const t of await page.locator('#pools tbody tr td:nth-child(3)').allTextContents()) expect(t.toLowerCase()).toContain('prod');
  // El filtro se conserva en otra pestaña.
  await page.getByRole('button', { name: 'Asignaciones', exact: true }).click();
  await expect(page.locator('#asig #f-ambiente')).toHaveValue('prod');
  await page.getByRole('button', { name: 'Limpiar filtro' }).first().click();
  await page.getByRole('button', { name: 'Pools', exact: true }).click();
  await expect(page.locator('#pools #f-ambiente')).toHaveValue('');
});

test('cada asignación muestra su ID (ASG-000123) y se puede buscar por él', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Asignaciones', exact: true }).click();
  const filas = page.locator('#asig tbody tr').filter({ has: page.locator('td') });
  await expect(filas.first()).toBeVisible();
  const total = await filas.count();
  const id = (await filas.first().locator('td').first().textContent()).trim();
  expect(id).toMatch(/^ASG-\d{6,}$/);
  await page.fill('#f-buscar', id);
  await expect(filas).toHaveCount(1);
  await expect(filas.first()).toContainText(id);
  await page.fill('#f-buscar', '');
  await expect(filas).toHaveCount(total);
});
