const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

// Abre «Nueva asignación» (dentro de Asignaciones; reemplaza a la antigua pestaña «Asignar directo»).
async function abrirNuevaAsignacion(page) {
  await page.goto('/');
  await page.locator('#nav').getByRole('button', { name: 'Asignaciones', exact: true }).click();
  await page.locator('#asig summary', { hasText: 'Nueva asignación' }).click();
}

test('nueva asignación con VLAN → ver en la tabla → ficha con historial → exportar a Excel → liberar', async ({ page }) => {
  const vpc = `e2e-${Date.now()}`;
  await abrirNuevaAsignacion(page);
  // Ningún pool viene elegido y la máscara espera al pool.
  await expect(page.locator('#na-pool')).toHaveValue('');
  await expect(page.locator('#na-mascara')).toBeDisabled();
  await page.selectOption('#na-pool', 'gke-nodos-qa');
  await page.fill('#na-vpc', vpc);
  await page.selectOption('#na-mascara', '24');
  await page.fill('#na-vlan', '210');
  await page.fill('#na-vlan-nombre', 'e2e-vlan');
  await page.click('#na-go');
  await expect(page.locator('#asig-msg .ok')).toContainText('Asignado');

  const fila = page.locator('#asig tr', { hasText: vpc });
  await expect(fila).toBeVisible();
  await expect(fila).toContainText('210 · e2e-vlan');

  // Ficha del segmento: detalle e historial.
  await fila.locator('button.enlace').click();
  const ficha = page.getByRole('dialog');
  await expect(ficha.getByRole('heading', { level: 2 })).toHaveText(/\/24$/);
  await expect(ficha).toContainText('Primera dirección');
  await expect(ficha).toContainText('e2e-vlan');
  await ficha.getByRole('tab', { name: 'Historial' }).click();
  await expect(ficha.getByRole('list', { name: 'Historial' })).toContainText('asignó');
  await ficha.getByRole('button', { name: 'Cerrar' }).click();
  await expect(ficha).toHaveCount(0);

  const [descarga] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: /Exportar a Excel/ }).click()]);
  expect(descarga.suggestedFilename()).toMatch(/^ipam-segmentos-\d{4}-\d{2}-\d{2}\.xlsx$/);

  page.once('dialog', (d) => d.accept('prueba e2e: ya no se necesita'));
  await fila.getByRole('button', { name: 'Liberar' }).click();
  await expect(page.locator('tr', { hasText: vpc })).toHaveCount(0);
  // El motivo queda registrado.
  const aud = await (await page.request.get('/api/v1/auditoria')).json();
  expect(aud.some((f) => f.accion === 'liberar' && f.detalle.motivo === 'prueba e2e: ya no se necesita')).toBe(true);
});

test('un CIDR solapado muestra la alerta y sugiere segmentos libres', async ({ page }) => {
  await abrirNuevaAsignacion(page);
  await page.selectOption('#na-pool', 'gke-pods-prod');
  await page.fill('#na-vpc', 'vpc-e2e-solapado');
  await page.fill('#na-cidr', '10.64.8.0/22');
  await page.click('#na-go');
  await expect(page.locator('#na-res .alert')).toContainText('Solapamiento detectado');
  await expect(page.locator('#na-res .sug').first()).toBeVisible();
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

test('al elegir un pool se ve cuántas direcciones y bloques libres quedan, y solo las máscaras que caben en él', async ({ page }) => {
  await abrirNuevaAsignacion(page);
  await page.selectOption('#na-pool', 'gke-nodos-qa'); // 10.20.0.0/16 con un /20 asignado en la semilla
  const tabla = page.getByRole('table', { name: 'Disponibilidad por máscara' });
  await expect(tabla).toBeVisible();
  const fila24 = tabla.locator('tr', { has: page.locator('code', { hasText: /^\/24$/ }) });
  await expect(fila24).toContainText('256'); // direcciones por bloque
  await expect(fila24).toContainText('254'); // utilizables
  await expect(page.locator('#na-mascara option[value="24"]')).toContainText('libres');
  // Nada más grande que el propio pool (/16): ya no aparece «no cabe aquí».
  await expect(page.locator('#na-mascara option[value="15"]')).toHaveCount(0);
  await expect(page.locator('#na-mascara option[value="8"]')).toHaveCount(0);
  await expect(page.locator('#na-mascara')).toHaveValue('');
  // Un clic en una fila elige esa máscara.
  await tabla.locator('tr', { has: page.locator('code', { hasText: /^\/26$/ }) }).click();
  await expect(page.locator('#na-mascara')).toHaveValue('26');
  // La misma información está en «Nueva reserva».
  await page.getByRole('button', { name: 'Reservas', exact: true }).click();
  await page.locator('#reservas summary').click();
  await expect(page.locator('#nr-pool')).toHaveValue('');
  await page.selectOption('#nr-pool', 'gke-nodos-qa');
  await expect(page.locator('#nr-disp').getByRole('table', { name: 'Disponibilidad por máscara' })).toBeVisible();
});

test('ficha de un pool: uso asignado + reservado, segmentos e historial, accesible', async ({ page }) => {
  await page.goto('/');
  await page.locator('#pools').getByRole('button', { name: 'gke-nodos-qa', exact: true }).click();
  const ficha = page.getByRole('dialog');
  await expect(ficha.getByRole('heading', { level: 2 })).toHaveText('10.20.0.0/16');
  await expect(ficha).toContainText('Bloque libre más grande');
  await expect(ficha).toContainText('ocupado (asignado');
  const axe = await new AxeBuilder({ page }).include('dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`)).toEqual([]);
  await ficha.getByRole('tab', { name: 'Segmentos' }).click();
  await expect(ficha.getByRole('table')).toContainText('10.20.0.0/20');
  await ficha.getByRole('tab', { name: 'Historial' }).click();
  await expect(ficha.getByRole('tabpanel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(ficha).toHaveCount(0);
});

test('Usuarios: la ve todo admin; sin cuentas habilitadas explica cómo habilitarlas en vez de ocultarse', async ({ page }) => {
  await page.goto('/');
  const pestana = page.locator('#nav').getByRole('button', { name: 'Usuarios', exact: true });
  await expect(pestana).toBeVisible();
  await pestana.click();
  const panel = page.locator('#usuarios');
  await expect(panel.getByRole('heading', { name: 'Usuarios', exact: true })).toBeVisible();
  await expect(panel).toContainText('no están habilitadas');
  await expect(panel).toContainText('AUTH_LOCAL=true');
  await expect(panel).toContainText('auth.local=true');
  await expect(panel.locator('#us-crear')).toHaveCount(0); // no ofrece un formulario que no puede funcionar
  const axe = await new AxeBuilder({ page }).include('#usuarios').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`)).toEqual([]);
});
