const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

const H = { 'X-Requested-With': 'ipam' };
const axeSin = async (page, selector) => {
  const r = await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`)).toEqual([]);
};

test('pools: un admin crea un bloque base, lo edita desde su ficha y lo elimina', async ({ page }) => {
  const id = `e2e-pool-${Date.now().toString(36)}`;
  await page.goto('/');
  await page.locator('#pools summary', { hasText: 'Nuevo pool' }).click();
  await page.fill('#np-id', id);
  await page.fill('#np-tipo', 'LAN');
  await page.selectOption('#np-ambiente', 'pre');
  await page.fill('#np-proveedor', 'On-prem');
  await page.fill('#np-cidr', '10.252.0.0/20');
  await page.click('#np-go');
  await expect(page.locator('#pools-msg')).toContainText(`Pool ${id}`);
  await page.locator('#pools').getByRole('button', { name: id, exact: true }).click();
  const ficha = page.getByRole('dialog');
  await expect(ficha.getByRole('heading', { level: 2 })).toHaveText('10.252.0.0/20');
  await ficha.getByText('Editar o eliminar este pool').click();
  await ficha.locator('#ep-tipo').fill('LAN sucursal');
  await ficha.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByRole('dialog')).toContainText('LAN sucursal');
  await page.getByRole('dialog').getByText('Editar o eliminar este pool').click();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('dialog').getByRole('button', { name: 'Eliminar pool' }).click();
  await expect(page.locator('#pools-msg')).toContainText(`Pool ${id} eliminado`);
  await expect(page.locator('#pools').getByRole('button', { name: id, exact: true })).toHaveCount(0);
});

test('IPs fijas: se registran desde la ficha del segmento, se buscan por equipo y se editan', async ({ page }) => {
  const equipo = `rtr-e2e-${Date.now().toString(36)}`;
  const a = await (await page.request.post('/api/v1/solicitudes', { headers: H, data: { pool: 'gke-nodos-qa', vpc: `vpc-${equipo}`, mascara: 28 } })).json();
  const n = a.cidr.split('/')[0].split('.').map(Number);
  const ip = `${n[0]}.${n[1]}.${n[2]}.${n[3] + 1}`;

  await page.goto('/');
  await page.locator('#nav').getByRole('button', { name: 'Asignaciones', exact: true }).click();
  await page
    .locator('#asig tr', { hasText: `vpc-${equipo}` })
    .locator('button.enlace')
    .click();
  const ficha = page.getByRole('dialog');
  await ficha.getByRole('tab', { name: 'Direcciones IP' }).click();
  await expect(ficha).toContainText('0 de 14 direcciones utilizables');
  await ficha.getByText('Registrar IP fija').click();
  await ficha.locator('#fi-ip').fill(ip);
  await ficha.locator('#fi-dispositivo').fill(equipo);
  await ficha.locator('#fi-interfaz').fill('Gi0/1');
  await ficha.locator('#fi-rol').selectOption('gateway');
  await ficha.locator('#fi-go').click();
  await expect(ficha).toContainText(`${ip} registrada en ${a.codigo}`);
  await expect(ficha.getByRole('table')).toContainText(equipo);
  await expect(ficha).toContainText('1 de 14 direcciones utilizables');
  await axeSin(page, 'dialog');
  await ficha.getByRole('button', { name: 'Cerrar' }).click();

  // Pestaña general: buscar por equipo y editar la interfaz.
  await page.locator('#nav').getByRole('button', { name: 'Direcciones IP', exact: true }).click();
  await page.fill('#ips-buscar', equipo);
  const fila = page.locator('#ips tbody tr', { hasText: equipo });
  await expect(fila).toHaveCount(1);
  await expect(fila).toContainText('Gateway');
  await expect(fila).toContainText(a.codigo);
  await fila.getByRole('button', { name: 'Editar' }).click();
  await page.locator('#ed-interfaz').fill('Gi0/2');
  await page.getByRole('dialog').getByRole('button', { name: 'Guardar' }).click();
  await expect(page.locator('#ips tbody tr', { hasText: equipo })).toContainText('Gi0/2');
  await axeSin(page, '#ips');

  // Fuera de un segmento sin motivo: no se registra.
  await page.locator('#ips summary', { hasText: 'Registrar IP fija' }).click();
  await page.fill('#ni-ip', '192.0.2.10'); // fuera de todo pool (rango de documentación)
  await page.click('#ni-go');
  await expect(page.locator('#ni-msg')).toContainText('Si es una excepción, indica el motivo');

  // Limpieza.
  const ips = await (await page.request.get(`/api/v1/direcciones?asignacion=${a.id}`)).json();
  for (const d of ips) await page.request.delete(`/api/v1/direcciones/${d.id}`, { headers: H });
  await page.request.delete(`/api/v1/asignaciones/${a.id}`, { headers: H, data: { motivo: 'limpieza e2e' } });
});

test('la página de la API muestra el contrato navegable, sin errores de seguridad de contenido', async ({ page }) => {
  const errores = [];
  page.on('console', (m) => m.type() === 'error' && errores.push(m.text()));
  page.on('pageerror', (e) => errores.push(e.message));
  await page.goto('/');
  await page.getByRole('link', { name: 'API', exact: true }).click();
  await expect(page).toHaveURL(/\/api\.html$/);
  await expect(page.getByRole('heading', { name: /Direcciones IP/ }).first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('heading', { name: /Reservas/ }).first()).toBeVisible();
  expect(errores).toEqual([]);
});

test('pools: «Nuevo pool» es un botón visible y el formulario permite elegir el ambiente', async ({ page }) => {
  await page.goto('/');
  const boton = page.locator('#pools summary.btn', { hasText: 'Nuevo pool' });
  await expect(boton).toBeVisible();
  await expect(page.locator('#np-ambiente')).toBeHidden();
  await boton.click();
  await expect(page.locator('#np-ambiente')).toBeVisible();
  await expect(page.locator('#np-ambiente option')).toHaveText(['Elige…', 'dev', 'qa', 'pre', 'prod']);
  await expect(page.locator('#pools details', { hasText: 'Nuevo pool' })).toContainText('en el ambiente que corresponda');
});
