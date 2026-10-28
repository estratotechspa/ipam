const { test, expect } = require('@playwright/test');

const H = { 'X-Requested-With': 'ipam' };

async function irA(page, nombre) {
  await page.goto('/');
  await page.locator('#nav').getByRole('button', { name: nombre, exact: true }).click();
}

test('navegación: teclado, aria-current, iconos y enlace para saltar al contenido', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('a.skip, a[href="#contenido"]').first()).toHaveCount(1);
  const asig = page.locator('#nav').getByRole('button', { name: 'Segmentos', exact: true });
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
  await irA(page, 'Segmentos');
  const th = page.locator('#segmentos th[aria-sort]').first();
  await expect(th).toBeVisible();
  await th.locator('button').click();
  await expect(page.locator('#segmentos th[aria-sort="ascending"], #segmentos th[aria-sort="descending"]').first()).toBeVisible();
  await page.locator('#f-buscar').pressSequentially('zzz-no-existe-zzz');
  await expect(page.locator('#segmentos')).toContainText(/sin resultados|no hay|ninguna/i);
});

test('nueva asignación: validación de CIDR en vivo', async ({ page }) => {
  await irA(page, 'Segmentos');
  await page.locator('#segmentos summary', { hasText: 'Asignar ahora' }).click();
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
  await irA(page, 'Segmentos');
  await page.fill('#segmentos input[type="search"]', vpc);
  await page
    .locator('#segmentos')
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

test('Segmentos: asignado y reservado en una lista, con las reservas pendientes primero y filtros por estado', async ({ page, request }) => {
  const vpc = `seg-${Date.now().toString(36)}`;
  const a = await (await request.post('/api/v1/solicitudes', { headers: H, data: { pool: 'gke-nodos-qa', vpc: vpc + '-a', mascara: 28 } })).json();
  const r = await (
    await request.post('/api/v1/reservas', {
      headers: { ...H, 'Idempotency-Key': `seg-${vpc}` },
      data: { ambiente: 'qa', tipo: 'Nodos', mascara: 28, vpc: vpc + '-r' },
    })
  ).json();
  await irA(page, 'Segmentos');
  await expect(page.getByRole('heading', { name: 'Segmentos', exact: true })).toBeVisible();
  // Una sola pestaña para las dos cosas: ya no existen «Asignaciones» ni «Reservas» en la barra.
  await expect(page.locator('#nav').getByRole('button', { name: /^(Asignaciones|Reservas)$/ })).toHaveCount(0);

  // Cada fila dice su estado con texto (no solo color); las reservas pendientes salen antes que lo asignado.
  const filaR = page.locator('#segmentos tr', { hasText: vpc + '-r' });
  const filaA = page.locator('#segmentos tr', { hasText: vpc + '-a' });
  await expect(filaR.locator('.tag')).toHaveText('Reservado');
  await expect(filaA.locator('.tag')).toHaveText('Asignado');
  await expect(filaR).toContainText(/RES-[0-9A-F]{8}/);
  await expect(filaA).toContainText(a.codigo);
  await expect(filaR.locator('time.restante')).toBeVisible();
  const filas = page.locator('#segmentos tbody tr');
  const posR = await filas.evaluateAll((trs, texto) => trs.findIndex((t) => t.textContent.includes(texto)), vpc + '-r');
  const posA = await filas.evaluateAll((trs, texto) => trs.findIndex((t) => t.textContent.includes(texto)), vpc + '-a');
  expect(posR).toBeGreaterThanOrEqual(0);
  expect(posR).toBeLessThan(posA);

  // El contador de «Reservados» es lo pendiente de aprobar; cada botón filtra.
  await expect(page.getByRole('button', { name: /^Reservados/ }).locator('.n')).not.toHaveText('0');
  await page.getByRole('button', { name: /^Reservados/ }).click();
  await expect(page.getByRole('button', { name: /^Reservados/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(filaR).toBeVisible();
  await expect(filaA).toHaveCount(0);
  await page.getByRole('button', { name: /^Asignados/ }).click();
  await expect(page.getByRole('button', { name: /^Asignados/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(filaA).toBeVisible();
  await expect(filaR).toHaveCount(0);

  // Liberar la reserva la manda al historial (gris), con su estado escrito.
  await page.getByRole('button', { name: /^Reservados/ }).click();
  await expect(page.getByRole('button', { name: /^Reservados/ })).toHaveAttribute('aria-pressed', 'true');
  await filaR.getByRole('button', { name: /Liberar/ }).click();
  await page.locator('dialog.confirmar').getByRole('button', { name: 'Liberar', exact: true }).click();
  await expect(filaR).toHaveCount(0);
  await page.getByRole('button', { name: /^Historial/ }).click();
  await expect(page.getByRole('button', { name: /^Historial/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(filaR.locator('.tag')).toHaveText('Liberada');
  await expect(filaR.getByRole('button')).toHaveCount(0); // el historial no se opera

  // Limpieza.
  await request.delete(`/api/v1/asignaciones/${a.id}`, { headers: H });
  expect(r.id).toBeTruthy();
});
