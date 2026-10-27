const { test, expect } = require('@playwright/test');
const { aceptar } = require('./ayudas');
const AxeBuilder = require('@axe-core/playwright').default;

test('importar segmentos: simular no escribe, el solapamiento con otro pool exige aprobación, aplicar importa y queda como «importado»', async ({ page }) => {
  const marca = `e2e-imp-${Date.now()}`;
  const r = Math.floor(Math.random() * 200) + 20;
  const csv = [
    'cidr,proyecto,tipo',
    `10.77.${r}.0/24,${marca}-a,Nodos`,
    `10.77.${r + 1}.0/24,${marca}-b,Pods`,
    `basura,${marca}-c,Nodos`,
    `10.20.0.0/24,${marca}-d,Nodos`, // solapa con gke-nodos-qa (otro pool)
  ].join('\n');
  await page.goto('/');
  await page
    .locator('#pools')
    .getByRole('button', { name: /Importar segmentos/ })
    .click(); // Importar vive dentro de Pools
  await expect(page.getByRole('heading', { name: 'Importar segmentos que ya existen' })).toBeVisible();
  await page.fill('#imp-prov', 'E2E-Test');
  await page.selectOption('#imp-amb', 'dev');
  await page.setInputFiles('#imp-archivo', { name: 'segmentos.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.click('#imp-simular');
  await expect(page.getByRole('heading', { name: /Resultado de la simulación \(4 filas\)/ })).toBeVisible();

  // Simular NO escribe nada.
  const yaEsta = async () => (await (await page.request.get('/api/v1/asignaciones')).json()).filter((a) => a.vpc.startsWith(marca));
  expect(await yaEsta()).toHaveLength(0);

  const tabla = page.getByRole('table', { name: 'Filas de la importación' });
  await expect(tabla.locator('tr', { hasText: `${marca}-d` })).toContainText('requiere aprobación');
  await expect(tabla.locator('tr', { hasText: `${marca}-c` })).toContainText('Inválida');
  await expect(page.locator('#imp-aplicar')).toHaveText('Importar 2 segmentos');

  // Accesibilidad del resultado.
  const axe = await new AxeBuilder({ page }).include('#importar').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`)).toEqual([]);

  // El admin aprueba el solapamiento: ahora se importan 3.
  await tabla
    .locator('tr', { hasText: `${marca}-d` })
    .getByRole('checkbox')
    .check();
  await expect(page.locator('#imp-aplicar')).toHaveText('Importar 3 segmentos');
  await page.click('#imp-aplicar');
  await aceptar(page, 'Importar');
  await expect(page.locator('#imp-msg')).toContainText('Importados 3 segmentos');

  const importadas = await yaEsta();
  expect(importadas).toHaveLength(3);
  expect(importadas.every((a) => a.origen === 'importado')).toBe(true);
  expect(importadas.every((a) => a.pool_id === 'imp-e2e-test-dev-10')).toBe(true);

  // Limpieza.
  for (const a of importadas)
    await page.request.delete(`/api/v1/asignaciones/${a.id}`, { headers: { 'X-Requested-With': 'ipam' }, data: { motivo: 'limpieza e2e' } });
  expect(await yaEsta()).toHaveLength(0);
});
