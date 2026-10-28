const { test, expect } = require('@playwright/test');
const { aceptar, cancelar, confirmarLiberacion } = require('./ayudas');
const AxeBuilder = require('@axe-core/playwright').default;

const CAB = { 'X-Requested-With': 'ipam' };
const unico = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Crea un token de agente por API (como lo haría un administrador) y devuelve {id, nombre, token}. */
async function tokenPorApi(request, rol = 'agente') {
  const nombre = `e2e-${unico()}`;
  const r = await request.post('/api/v1/tokens', { headers: CAB, data: { nombre, rol } });
  expect(r.status()).toBe(201);
  return { nombre, ...(await r.json()) };
}
const reservarComo = (request, token, extra = {}) =>
  request.post('/api/v1/reservas', {
    headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': `e2e-${unico()}` },
    data: { ambiente: 'qa', tipo: 'Nodos', mascara: 28, vpc: `e2e-${unico()}`, ...extra },
  });
const irA = async (page, pestana) => {
  await page.goto('/');
  await page.locator('#nav').getByRole('button', { name: pestana, exact: true }).click();
};

test('crear un token: se muestra una sola vez, se copia al portapapeles y aparece en la lista; revocarlo con confirmación', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const nombre = `e2e-${unico()}`;
  await irA(page, 'Tokens');
  await expect(page.getByRole('heading', { name: 'Tokens de servicio' })).toBeVisible();
  await page.getByRole('button', { name: 'Crear token' }).click();

  const dlg = page.getByRole('dialog');
  await expect(dlg).toBeVisible();
  await expect(dlg.getByLabel('Nombre')).toBeFocused();
  await dlg.getByLabel('Nombre').fill(nombre);
  await dlg.getByLabel('Rol').selectOption('agente');
  await dlg.getByRole('button', { name: 'Crear token' }).click();

  // El token se ve una sola vez, con aviso y botón Copiar.
  await expect(dlg.getByRole('alert')).toContainText('No se podrá ver de nuevo');
  const token = await dlg.getByLabel('Token de servicio').inputValue();
  expect(token).toMatch(/^ipam_[A-Za-z0-9_-]{43}$/);
  await dlg.getByRole('button', { name: 'Copiar' }).click();
  await expect(dlg.getByText('Copiado al portapapeles.')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);
  await dlg.getByRole('button', { name: 'Cerrar' }).click();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(token); // al cerrar no queda en la página

  // Aparece en la lista, solo con su prefijo, y el token sirve contra la API.
  const fila = page.locator('tr', { hasText: nombre });
  await expect(fila).toBeVisible();
  await expect(fila).toContainText(token.slice(0, 9));
  await expect(fila).toContainText('activo');
  await expect(fila).toContainText('nunca');
  expect((await page.request.get('/api/v1/me', { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(200);

  // Revocar pide confirmación y deja de servir al instante.
  await fila.getByRole('button', { name: /Revocar/ }).click();
  await cancelar(page, { contiene: nombre });
  await expect(fila).toContainText('activo');
  await fila.getByRole('button', { name: /Revocar/ }).click();
  await aceptar(page, 'Revocar token');
  await expect(page.locator('tr', { hasText: nombre })).toContainText('revocado');
  await expect(page.locator('tr', { hasText: nombre }).getByRole('button')).toHaveCount(0);
  expect((await page.request.get('/api/v1/me', { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(401);
});

test('el diálogo de token se maneja con teclado: Escape cierra y devuelve el foco; nombre inválido se rechaza', async ({ page }) => {
  await irA(page, 'Tokens');
  const abrir = page.getByRole('button', { name: 'Crear token' });
  await abrir.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByLabel('Nombre').fill('Nombre Inválido');
  await page.getByRole('button', { name: 'Crear token' }).last().click();
  await expect(page.getByRole('dialog')).toBeVisible(); // el formulario no se envía con un nombre inválido
  expect(
    await page
      .getByRole('dialog')
      .getByLabel('Nombre')
      .evaluate((e) => e.validity.patternMismatch),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(abrir).toBeFocused();
});

test('reservas: listar, filtrar, confirmar y liberar con confirmación y cuenta regresiva', async ({ page, request }) => {
  const t = await tokenPorApi(request);
  const r = await (await reservarComo(request, t.token)).json();
  await irA(page, 'Segmentos');
  await expect(page.getByRole('heading', { name: 'Segmentos', exact: true })).toBeVisible();
  const fila = page.locator('tr', { hasText: r.vpc });
  await expect(fila).toBeVisible();
  await expect(fila).toContainText(r.cidr);
  await expect(fila).toContainText('svc:' + t.nombre);
  await expect(fila).toContainText('Reservado');
  await expect(fila.locator('time.restante')).toContainText(/^23 h \d+ min$|^1 d 0 h$|^24 h$/); // cuenta regresiva del TTL (24 h)

  // Filtros por estado (botones), búsqueda por solicitante y ambiente/proveedor.
  await page.getByRole('button', { name: /^Asignados/ }).click();
  await expect(page.getByRole('button', { name: /^Asignados/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('tr', { hasText: r.vpc })).toHaveCount(0);
  await page.getByRole('button', { name: /^Reservados/ }).click();
  await expect(page.locator('tr', { hasText: r.vpc })).toBeVisible();
  await page.getByRole('button', { name: /^Todos/ }).click();
  await expect(page.getByRole('button', { name: /^Todos/ })).toHaveAttribute('aria-pressed', 'true'); // solo la pantalla ya redibujada lo tiene: recién ahí se puede escribir sin que se pierda
  await page.locator('#f-buscar').pressSequentially('svc:' + t.nombre);
  await expect(page.locator('#segmentos tbody tr')).toHaveCount(1);
  await expect(page.locator('tr', { hasText: r.vpc })).toBeVisible();

  // Confirmar pide confirmación; al aceptar la reserva pasa a ser una asignación (definitiva).
  await page
    .locator('tr', { hasText: r.vpc })
    .getByRole('button', { name: /Confirmar/ })
    .click();
  await cancelar(page, { contiene: r.cidr });
  await expect(page.locator('tr', { hasText: r.vpc })).toContainText('Reservado');
  await page
    .locator('tr', { hasText: r.vpc })
    .getByRole('button', { name: /Confirmar/ })
    .click();
  await aceptar(page, 'Confirmar');
  await expect(page.locator('#seg-msg')).toContainText('confirmada');
  const asignada = page.locator('tr', { hasText: r.vpc });
  await expect(asignada).toContainText('Asignado');
  await expect(asignada).toContainText(/ASG-\d+/);
  expect((await (await page.request.get('/api/v1/asignaciones')).json()).some((a) => a.cidr === r.cidr && a.origen === 'agente')).toBe(true);

  // Liberar una asignación (nacida de una reserva) pide motivo y la segunda confirmación, y borra la asignación.
  await asignada.getByRole('button', { name: /Liberar/ }).click();
  await aceptar(page, 'Liberar segmento', { motivo: 'prueba e2e', encadenado: true });
  await confirmarLiberacion(page, r.cidr);
  await expect(page.locator('tr', { hasText: r.vpc })).toHaveCount(0);
  expect((await (await page.request.get('/api/v1/asignaciones')).json()).some((a) => a.cidr === r.cidr)).toBe(false);
});

test('la cuenta regresiva avanza sola y marca como vencida una reserva sin tiempo', async ({ page, request }) => {
  const t = await tokenPorApi(request);
  const r = await (await reservarComo(request, t.token, { ttl_horas: 1 })).json(); // con menos de 1 h se muestran los segundos
  await irA(page, 'Segmentos');
  const tiempo = page.locator('tr', { hasText: r.vpc }).locator('time.restante');
  await expect(tiempo).toHaveText(/^\d+ min \d+ s$/);
  await expect(tiempo).toHaveClass(/poco/); // menos de una hora: se resalta
  const antes = await tiempo.textContent();
  await page.waitForTimeout(2200);
  expect(await tiempo.textContent()).not.toBe(antes);
  // Simula que ya no le queda tiempo (sin esperar 24 h): la interfaz la muestra como vencida.
  await tiempo.evaluate((e) => {
    e.dataset.fin = String(Date.now() - 1000);
  });
  await expect(tiempo).toHaveText('vencida');
  await request.delete(`/api/v1/reservas/${r.id}`, { headers: CAB });
});

test('seguridad de la interfaz: lo que escribe un usuario se muestra como texto, nunca se ejecuta', async ({ page, request }) => {
  const t = await tokenPorApi(request);
  const malicioso = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>${unico()}`;
  const r = await (await reservarComo(request, t.token, { vpc: malicioso, ticket: 'NET-xss' })).json();
  await page.addInitScript(() => {
    window.__xss = undefined;
  });
  await irA(page, 'Segmentos');
  await expect(page.getByText(malicioso, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  expect(await page.locator('#segmentos img').count()).toBe(0);
  await page.locator('#nav').getByRole('button', { name: 'Segmentos', exact: true }).click();
  await page.locator('#nav').getByRole('button', { name: 'Pools', exact: true }).click();
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  await request.delete(`/api/v1/reservas/${r.id}`, { headers: CAB });
});

test('accesibilidad (axe): las pestañas Segmentos y Tokens y el diálogo no tienen infracciones serias', async ({ page, request }) => {
  const t = await tokenPorApi(request);
  await reservarComo(request, t.token);
  await irA(page, 'Segmentos');
  await expect(page.locator('#segmentos tbody tr').first()).toBeVisible();
  const reservas = await new AxeBuilder({ page }).include('#segmentos').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(reservas.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`)).toEqual([]);
  await page.locator('#nav').getByRole('button', { name: 'Tokens', exact: true }).click();
  await expect(page.locator('#tokens tbody tr').first()).toBeVisible();
  const tokens = await new AxeBuilder({ page }).include('#tokens').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(tokens.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`)).toEqual([]);
  await page.getByRole('button', { name: 'Crear token' }).click();
  const dialogo = await new AxeBuilder({ page }).include('dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(dialogo.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`)).toEqual([]);
});

test('Jira → reserva → aprobación manual de un admin → asignación (nada se asigna sin aprobar)', async ({ page }) => {
  const vpc = `jira-e2e-${Date.now()}`;
  await irA(page, 'Jira');
  await page.locator('#j-como summary').click(); // el diagrama y el simulador van dentro de «Cómo funciona»
  await expect(page.getByText('Aprobación manual')).toBeVisible();
  await page.selectOption('#j-amb', 'qa');
  await page.selectOption('#j-tipo', 'Nodos');
  await page.selectOption('#j-len', '26');
  await page.fill('#j-vpc', vpc);
  await page.click('#j-go');
  await expect(page.locator('#j-res')).toContainText('Falta la aprobación manual');

  // Aún no hay asignación para ese proyecto…
  const sinAprobar = (await (await page.request.get('/api/v1/asignaciones')).json()).some((a) => a.vpc === vpc);
  expect(sinAprobar).toBe(false);
  // …sí hay una reserva de «jira-webhook» esperando.
  await irA(page, 'Segmentos');
  const fila = page.locator('tr', { hasText: vpc });
  await expect(fila).toContainText('jira-webhook');
  await expect(fila).toContainText('Reservado');

  // Un admin la aprueba: recién entonces se asigna, con origen «jira».
  await fila.getByRole('button', { name: /Confirmar/ }).click();
  await aceptar(page, 'Confirmar');
  await expect(page.locator('tr', { hasText: vpc })).toContainText('Asignado');
  const asignadas = await (await page.request.get('/api/v1/asignaciones')).json();
  const a = asignadas.find((x) => x.vpc === vpc);
  expect(a.origen).toBe('jira');
  expect(a.cidr).toMatch(/\/26$/);

  // Limpieza: liberar la asignación.
  await page.request.delete(`/api/v1/asignaciones/${a.id}`, { headers: { 'X-Requested-With': 'ipam' } });
});

test('Reservar desde la interfaz: se crea, queda pendiente y un admin la aprueba', async ({ page }) => {
  const vpc = `nueva-res-${Date.now()}`;
  await irA(page, 'Segmentos');
  await page.locator('#segmentos summary', { hasText: 'Reservar un segmento' }).click();
  await page.selectOption('#nr-pool', 'gke-nodos-qa');
  await page.fill('#nr-vpc', vpc);
  await page.selectOption('#nr-mascara', '26');
  await page.fill('#nr-vlan', '300');
  await page.click('#nr-go');
  await expect(page.locator('#seg-msg')).toContainText('Falta la aprobación de un admin');
  const fila = page.locator('tr', { hasText: vpc });
  await expect(fila).toContainText('Reservado');
  expect((await (await page.request.get('/api/v1/asignaciones')).json()).some((a) => a.vpc === vpc)).toBe(false);
  await fila.getByRole('button', { name: /Confirmar/ }).click();
  await aceptar(page, 'Confirmar');
  await expect(page.locator('tr', { hasText: vpc })).toContainText('Asignado');
  const a = (await (await page.request.get('/api/v1/asignaciones')).json()).find((x) => x.vpc === vpc);
  expect(a.cidr).toMatch(/\/26$/);
  expect(a.vlan).toBe(300); // la VLAN de la reserva pasa a la asignación
  await page.request.delete(`/api/v1/asignaciones/${a.id}`, { headers: { 'X-Requested-With': 'ipam' } });
});
