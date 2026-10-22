const { test, expect } = require('@playwright/test');

const CAB = { 'X-Requested-With': 'ipam' };
const unico = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

// XSS «almacenado»: un valor malicioso guardado por la API se muestra como TEXTO en TODAS las pestañas y nunca se ejecuta.
test('un valor malicioso se muestra como texto en Asignaciones, Jira y Auditoría y nunca se ejecuta', async ({ page, request }) => {
  const carga = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>${unico()}`;
  const a = await request.post('/api/v1/solicitudes', { headers: CAB, data: { pool: 'gke-nodos-qa', vpc: carga, mascara: 28 } });
  expect(a.status()).toBe(201);
  const idAsignacion = (await a.json()).id;
  const j = await request.post('/api/v1/jira/simular', { headers: CAB, data: { ambiente: 'qa', tipo: 'Nodos', mascara: 28, vpc: carga } });
  expect(j.status()).toBe(200);

  await page.addInitScript(() => {
    window.__xss = undefined;
  });
  await page.goto('/');
  const nav = page.locator('#nav');
  for (const pestana of ['Asignaciones', 'Jira', 'Auditoría', 'Pools', 'Reservas']) {
    await nav.getByRole('button', { name: pestana, exact: true }).click();
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.__xss), `se ejecutó código en la pestaña ${pestana}`).toBeUndefined();
    // Ningún elemento inyectado: la única imagen permitida es el logo de la marca (oculto cuando no hay logo).
    expect(await page.locator('.wrap:not(.hide) img, .wrap:not(.hide) script').count(), `elementos inyectados en ${pestana}`).toBe(0);
  }
  await nav.getByRole('button', { name: 'Asignaciones', exact: true }).click();
  await expect(page.getByText(carga, { exact: true }).first()).toBeVisible(); // se ve el texto literal, no un elemento
  await nav.getByRole('button', { name: 'Auditoría', exact: true }).click();
  await expect(page.locator('#audit')).toContainText('<img src=x'); // en el detalle JSON también como texto

  // Limpieza: libera las asignaciones de la prueba.
  await request.delete(`/api/v1/asignaciones/${idAsignacion}`, { headers: CAB });
  for (const x of await (await request.get('/api/v1/asignaciones')).json())
    if (x.vpc === carga) await request.delete(`/api/v1/asignaciones/${x.id}`, { headers: CAB });
});
