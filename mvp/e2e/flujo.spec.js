const { test, expect } = require('@playwright/test');

test('solicitar → ver en asignaciones → exportar a Excel → liberar', async ({ page }) => {
  const vpc = `e2e-${Date.now()}`;
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Estado de pools' })).toBeVisible();

  await page.getByRole('button', { name: 'Solicitar', exact: true }).click();
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

  await fila.getByRole('button', { name: 'Liberar' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Liberar segmento' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'liberado' })).toBeVisible();
  await expect(page.locator('tr', { hasText: vpc })).toHaveCount(0);
});

test('un CIDR solapado muestra la alerta y sugiere segmentos libres', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Solicitar', exact: true }).click();
  await page.selectOption('#s-pool', 'gke-pods-prod');
  await page.fill('#s-vpc', 'vpc-e2e-choque');
  await page.fill('#s-cidr', '10.64.8.0/22');
  await page.click('#s-go');
  await expect(page.locator('#s-res .alert')).toContainText('Solapamiento detectado');
  await expect(page.locator('#s-res .sug').first()).toBeVisible();
});
