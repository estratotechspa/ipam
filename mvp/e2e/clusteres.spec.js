const { test, expect } = require('@playwright/test');
const { aceptar } = require('./ayudas');
const AxeBuilder = require('@axe-core/playwright').default;

const H = { 'X-Requested-With': 'ipam' };

test('Clústeres: un grupo del agente se ve entero, se aprueba junto y sus rangos se ven en Segmentos y en el resumen del pool', async ({ page }) => {
  const s = Date.now().toString(36);
  const nodos = 40 + Math.floor(Math.random() * 20);
  const svc = 80 + Math.floor(Math.random() * 15);
  const pods = 200 + 4 * Math.floor(Math.random() * 10);
  const pools = { nodos: `e2e-cl-nodos-${s}`, pods: `e2e-cl-pods-${s}`, servicios: `e2e-cl-svc-${s}` };
  const alta = (id, cidr) => page.request.post('/api/v1/pools', { headers: H, data: { id, tipo: 'Prueba', ambiente: 'lab', proveedor: 'GCP', cidr } });
  expect((await alta(pools.nodos, `10.${nodos}.0.0/16`)).status()).toBe(201);
  expect((await alta(pools.pods, `10.${pods}.0.0/14`)).status()).toBe(201);
  expect((await alta(pools.servicios, `10.${svc}.0.0/16`)).status()).toBe(201);
  for (const [uso, pool] of Object.entries(pools))
    expect((await page.request.put(`/api/v1/pool-uso/lab/${uso}`, { headers: H, data: { pool } })).status()).toBe(200);

  const proyecto = `proy-e2e-${s}`;
  const lote = await page.request.post('/api/v1/reservas/lote', {
    headers: H,
    data: { ambiente: 'lab', proyecto, subred: 'gke-e2e', rangos: [{ uso: 'nodos', mascara: 24 }, { uso: 'pods', nombre: `pods-${s}` }, { uso: 'servicios' }] },
  });
  expect(lote.status()).toBe(201);
  const grupo = (await lote.json()).grupo.grupo;

  await page.goto('/');
  await page.locator('#nav').getByRole('button', { name: 'Clústeres' }).click();
  await expect(page.getByRole('heading', { name: 'Clústeres GKE' })).toBeVisible();
  await page.locator('#f-buscar-cl').fill(proyecto);
  const fila = page.locator('tr.grupo-cluster', { hasText: proyecto });
  await expect(fila).toHaveCount(1);
  await expect(fila).toContainText(`10.${nodos}.0.0/24`);
  await expect(fila).toContainText(`10.${pods}.0.0/14`);
  await expect(fila).toContainText(`10.${svc}.0.0/20`);
  await expect(fila).toContainText('Reservado');
  await expect(fila.locator('.tag.lab')).toBeVisible();

  await fila.getByRole('button', { name: /Expandir/ }).click();
  await expect(page.locator('table.rangos')).toContainText(`pods-${s}`);
  const axe = await new AxeBuilder({ page }).include('#clusteres').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`)).toEqual([]);
  await page.getByRole('button', { name: 'Aprobar los 3 rangos' }).click();
  await aceptar(page, 'Aprobar');
  await expect(page.locator('tr.grupo-cluster', { hasText: proyecto })).toContainText('Aprobado');

  // Segmentos: columna «Rango» y búsqueda por el nombre del rango.
  await page.locator('#nav').getByRole('button', { name: 'Segmentos' }).click();
  await page.locator('#f-buscar').fill(`pods-${s}`);
  await expect(page.locator('#segmentos tbody tr')).toHaveCount(1);
  await expect(page.locator('#segmentos tbody tr')).toContainText('Pods');

  // Ficha del pool: resumen en lenguaje sencillo, con «qué cabe todavía».
  await page.locator('#nav').getByRole('button', { name: 'Pools' }).click();
  await page.locator('#pools').getByRole('button', { name: pools.nodos, exact: true }).click();
  const ficha = page.getByRole('dialog');
  await expect(ficha).toContainText('de esta red');
  await expect(ficha.getByRole('heading', { name: '¿Qué cabe todavía en esta red?' })).toBeVisible();
  await expect(ficha.locator('table.cabe')).toContainText('Una subred normal');
  await expect(ficha.getByText('Ver el mapa detallado')).toBeVisible();
  await ficha.getByRole('button', { name: 'Cerrar' }).click();

  // Limpieza: libera el grupo (admin) y quita la tabla y los pools.
  expect((await page.request.delete(`/api/v1/reservas/grupo/${grupo}`, { headers: H })).status()).toBe(200);
  for (const uso of Object.keys(pools)) await page.request.delete(`/api/v1/pool-uso/lab/${uso}`, { headers: H });
  for (const id of Object.values(pools)) await page.request.delete(`/api/v1/pools/${id}`, { headers: H });
});
