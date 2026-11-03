const { test, expect } = require('@playwright/test');
const { aceptar } = require('./ayudas');
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
  await page.getByRole('dialog').getByRole('button', { name: 'Eliminar pool' }).click();
  await aceptar(page, 'Eliminar pool');
  await expect(page.locator('#pools-msg')).toContainText(`Pool ${id} eliminado`);
  await expect(page.locator('#pools').getByRole('button', { name: id, exact: true })).toHaveCount(0);
});

test('pools: el menú de tres puntos elimina un pool vacío y explica por qué no deja borrar uno con segmentos', async ({ page }) => {
  const id = `e2e-menu-${Date.now().toString(36)}`;
  const nuevo = { id, tipo: 'LAN', ambiente: 'pre', proveedor: 'On-prem', cidr: '10.252.16.0/20' };
  expect((await page.request.post('/api/v1/pools', { headers: H, data: nuevo })).status()).toBe(201);
  await page.goto('/');
  await page.getByRole('button', { name: `Acciones de ${id}` }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Ver ficha', 'Eliminar pool']);
  await page.getByRole('menuitem', { name: 'Eliminar pool' }).click();
  await aceptar(page, 'Eliminar pool');
  await expect(page.locator('#pools-msg')).toContainText(`Pool ${id} eliminado`);
  await expect(page.getByRole('button', { name: `Acciones de ${id}` })).toHaveCount(0);

  // Con segmentos no se borra: el motivo queda en pantalla y el pool sigue ahí.
  await page.getByRole('button', { name: 'Acciones de gke-nodos-qa' }).click();
  await page.getByRole('menuitem', { name: 'Eliminar pool' }).click();
  await aceptar(page, 'Eliminar pool');
  await expect(page.locator('#pools-msg')).toContainText('gke-nodos-qa');
  await expect(page.getByRole('button', { name: 'Acciones de gke-nodos-qa' })).toHaveCount(1);
});

test('IPs fijas: se registran desde la ficha del segmento, se buscan por equipo y se editan', async ({ page }) => {
  const equipo = `rtr-e2e-${Date.now().toString(36)}`;
  const a = await (await page.request.post('/api/v1/solicitudes', { headers: H, data: { pool: 'gke-nodos-qa', vpc: `vpc-${equipo}`, mascara: 28 } })).json();
  const n = a.cidr.split('/')[0].split('.').map(Number);
  const ip = `${n[0]}.${n[1]}.${n[2]}.${n[3] + 1}`;

  await page.goto('/');
  await page.locator('#nav').getByRole('button', { name: 'Segmentos', exact: true }).click();
  await page
    .locator('#segmentos tr', { hasText: `vpc-${equipo}` })
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
  await expect(page.locator('#np-ambiente option')).toHaveText(['Elige…', 'dev', 'qa', 'lab', 'pre', 'prod']);
  await expect(page.locator('#pools details', { hasText: 'Nuevo pool' })).toContainText('en el ambiente que corresponda');
});

test('pools: cada fila despliega y contrae sus segmentos en la misma pestaña, y el nombre sigue abriendo la ficha lateral', async ({ page, request }) => {
  const marca = `desplegar-${Date.now()}`;
  const a = await (await request.post('/api/v1/solicitudes', { headers: H, data: { pool: 'gke-nodos-qa', vpc: marca, mascara: 28 } })).json();
  await page.goto('/');
  await page.locator('#nav').getByRole('button', { name: 'Pools', exact: true }).click();
  const boton = page.getByRole('button', { name: 'Mostrar los segmentos de gke-nodos-qa' });
  await expect(boton).toHaveAttribute('aria-expanded', 'false');
  await boton.click();
  const detalle = page.locator('#seg-pool-gke-nodos-qa');
  await expect(detalle).toBeVisible();
  await expect(detalle).toContainText(marca);
  await expect(page.getByRole('button', { name: 'Ocultar los segmentos de gke-nodos-qa' })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('dialog')).toHaveCount(0); // sin panel lateral

  // Un segmento asignado abre su ficha en el panel lateral (la otra opción).
  await detalle.getByRole('button', { name: new RegExp(a.cidr.replace(/[./]/g, '\\$&')) }).click();
  await expect(page.getByRole('dialog')).toContainText(marca);
  await page.getByRole('dialog').getByRole('button', { name: 'Cerrar' }).click();

  // Contraer una fila, y expandir / contraer todos.
  await page.getByRole('button', { name: 'Ocultar los segmentos de gke-nodos-qa' }).click();
  await expect(detalle).toBeHidden();
  await page.getByRole('button', { name: 'Expandir todos' }).click();
  const filas = await page.locator('#pools [data-expandir-pool]').count();
  await expect(page.locator('#pools tr.detalle-pool:not([hidden])')).toHaveCount(filas);
  await expect(detalle).toContainText(marca);
  await page.getByRole('button', { name: 'Contraer todos' }).click();
  await expect(page.locator('#pools tr.detalle-pool:not([hidden])')).toHaveCount(0);

  // El nombre del pool sigue abriendo la ficha en el panel lateral.
  await page.locator('#pools').getByRole('button', { name: 'gke-nodos-qa', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cerrar' }).click();

  await request.delete(`/api/v1/asignaciones/${a.id}`, { headers: H });
});

test('buscador de texto: Pools encuentra el pool por su nombre o por el contenido de sus segmentos, y Segmentos por cualquier dato', async ({
  page,
  request,
}) => {
  const marca = `buscar-${Date.now()}`;
  const a = await (
    await request.post('/api/v1/solicitudes', {
      headers: H,
      data: { pool: 'gke-nodos-qa', vpc: `${marca}-vpc`, proyecto: `${marca}-proy`, subred: `${marca}-subred`, mascara: 28 },
    })
  ).json();
  await page.goto('/'); // Pools es la pestaña inicial: no se vuelve a pulsar (rehacería la pantalla mientras se escribe)
  await expect(page.locator('#pools [data-expandir-pool]').first()).toBeVisible();
  const total = await page.locator('#pools [data-expandir-pool]').count();
  expect(total).toBeGreaterThan(2);

  // Por el contenido de un segmento: queda solo su pool, abierto y con solo ese segmento.
  await page.locator('#p-buscar').fill(`${marca}-subred`);
  await expect(page.locator('#pools [data-expandir-pool]')).toHaveCount(1);
  await expect(page.locator('#pools')).toContainText('1 de');
  const detalle = page.locator('#seg-pool-gke-nodos-qa');
  await expect(detalle).toBeVisible();
  await expect(detalle).toContainText(`${marca}-vpc`);
  await expect(detalle).toContainText('Solo los segmentos que coinciden');
  await expect(page.locator('#p-buscar')).toBeFocused(); // la pantalla se rehízo sin quitar el foco

  // Sin coincidencias.
  await page.locator('#p-buscar').fill('zzz-no-existe-zzz');
  await expect(page.locator('#pools')).toContainText('Ningún pool ni segmento coincide');
  await expect(page.locator('#pools [data-expandir-pool]')).toHaveCount(0);

  // Por el nombre del pool, y al borrar vuelven todos (y el pool deja de estar abierto por la búsqueda).
  await page.locator('#p-buscar').fill('gke-cp-prod');
  await expect(page.locator('#pools [data-expandir-pool]')).toHaveCount(1);
  await page.locator('#p-buscar').fill('');
  await expect(page.locator('#pools [data-expandir-pool]')).toHaveCount(total);
  await expect(page.locator('#seg-pool-gke-nodos-qa')).toBeHidden();

  // Segmentos: el mismo texto encuentra el segmento por su subred.
  await page.locator('#nav').getByRole('button', { name: 'Segmentos', exact: true }).click();
  await page.locator('#f-buscar').fill(`${marca}-subred`);
  await expect(page.locator('#segmentos tbody tr')).toHaveCount(1);
  await expect(page.locator('#segmentos tbody tr')).toContainText(`${marca}-proy`);

  await request.delete(`/api/v1/asignaciones/${a.id}`, { headers: H });
});
