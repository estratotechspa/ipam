const { test, expect } = require('@playwright/test');

// Contraste real de lo que se ve: el color de cada elemento (resuelto por el navegador) contra el fondo opaco más cercano.
async function contrastes(page, selector) {
  return page.evaluate((sel) => {
    const px = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const aRgb = (c) => { px.clearRect(0, 0, 1, 1); px.fillStyle = '#000'; px.fillStyle = c; px.fillRect(0, 0, 1, 1); const d = px.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
    const luz = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const fondo = (el) => { for (let e = el; e; e = e.parentElement) { const c = aRgb(getComputedStyle(e).backgroundColor); if (c[3] > 0.99) return c; } return [255, 255, 255, 1]; };
    return [...document.querySelectorAll(sel)].filter((e) => e.offsetParent).map((e) => {
      const f = aRgb(getComputedStyle(e).color), b = fondo(e), [x, y] = [luz(f), luz(b)].sort((p, q) => q - p);
      return { texto: e.textContent.trim().slice(0, 30), ratio: (x + 0.05) / (y + 0.05) };
    });
  }, selector);
}

for (const esquema of ['light', 'dark']) {
  test(`contraste renderizado en modo ${esquema}: etiquetas, texto atenuado, botones y mensajes ≥ 4,5:1`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: esquema });
    await page.goto('/');
    await expect(page.locator('.tag.prod').first()).toBeVisible();
    for (const sel of ['.tag', '.muted', '.sub', 'th', 'td', 'h2', '.btn', '.kpi']) {
      const r = await contrastes(page, sel);
      expect(r.length, sel).toBeGreaterThan(0);
      for (const c of r) expect(c.ratio, `${sel} «${c.texto}»`).toBeGreaterThanOrEqual(4.5);
    }
    await page.getByRole('button', { name: 'Solicitar', exact: true }).click();
    for (const c of await contrastes(page, 'label')) expect(c.ratio, `label «${c.texto}»`).toBeGreaterThanOrEqual(4.5);
    await page.selectOption('#s-pool', 'gke-pods-prod');
    await page.fill('#s-vpc', 'vpc-contraste');
    await page.fill('#s-cidr', '10.64.8.0/22');
    await page.click('#s-go');
    await expect(page.locator('#s-res [role=alert]')).toBeVisible();
    for (const sel of ['#s-res .alert', '#s-res .alert b']) for (const c of await contrastes(page, sel)) expect(c.ratio, sel).toBeGreaterThanOrEqual(4.5);
  });
}

test('teclado: foco visible, aria-current en la navegación y enlace para saltar al contenido', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.locator('.saltar')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#nav button[data-t=pools]')).toBeFocused();
  const anillo = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return { estilo: s.outlineStyle, ancho: parseFloat(s.outlineWidth) }; });
  expect(anillo.estilo).not.toBe('none');
  expect(anillo.ancho).toBeGreaterThanOrEqual(2);

  await expect(page.locator('#nav button[aria-current=page]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Asignaciones' }).click();
  await expect(page.locator('#nav button[data-t=asig]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#nav button[data-t=pools]')).not.toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#nav button[aria-current=page]')).toHaveCount(1);
});

test('iconos SVG en lugar de glifos: ocultos a lectores de pantalla y con texto al lado', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#nav button svg[aria-hidden=true]')).toHaveCount(await page.locator('#nav button[data-ic]').count());
  await expect(page.getByRole('link', { name: 'Exportar a Excel' }).locator('svg')).toHaveAttribute('aria-hidden', 'true');
  for (const t of ['pools', 'asig', 'sol', 'jira']) {
    await page.locator(`#nav [data-t=${t}]`).click();
    expect(await page.locator('body').innerText()).not.toMatch(/[⬇✔⚠→]/u);
  }
  await expect(page.locator('link[rel=icon]')).toHaveAttribute('href', '/favicon.svg');
  expect((await page.request.get('/favicon.svg')).headers()['content-type']).toContain('image/svg+xml');
});

test('formularios y tablas: etiquetas asociadas, thead/th scope, roles de mensaje', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Solicitar', exact: true }).click();
  for (const id of ['s-pool', 's-vpc', 's-cidr', 's-len']) {
    expect(await page.locator('#' + id).evaluate((e) => e.labels.length), id).toBe(1);
  }
  for (const tab of ['pools', 'asig']) {
    await page.locator(`#nav [data-t=${tab}]`).click();
    const t = page.locator(`#${tab} table`);
    await expect(t.locator('thead th[scope=col]').first()).toBeVisible();
    expect(await t.locator('th:not([scope])').count()).toBe(0);
    expect(await t.locator('thead').count()).toBe(1);
  }
  // error → role=alert; éxito → role=status
  await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/pools')), page.getByRole('button', { name: 'Solicitar', exact: true }).click()]);
  const vpc = `a11y-${Date.now()}`;
  await page.selectOption('#s-pool', 'gke-nodos-qa');
  await page.fill('#s-vpc', vpc);
  await page.fill('#s-cidr', '');
  await page.selectOption('#s-len', '28');
  await page.click('#s-go');
  await expect(page.locator('#s-res [role=status]')).toContainText('Asignado');
  await page.fill('#s-cidr', '10.20.0.0/22');
  await page.click('#s-go');
  await expect(page.locator('#s-res [role=alert]')).toBeVisible();
  const lista = await (await page.request.get(`/api/asignaciones?q=${vpc}`)).json();
  for (const a of lista) await page.request.delete(`/api/asignaciones/${a.id}`, { headers: { 'X-Requested-With': 'ipam' } });
});

test('reflujo: sin desplazamiento horizontal de la página a 320 px (también con una fuente más ancha)', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/');
  // las fuentes de Linux (CI) son más anchas que las de macOS: se simula para no depender de la máquina
  await page.addStyleTag({ content: 'body{font-family:"DejaVu Sans",Verdana,sans-serif !important;letter-spacing:.02em}' });
  for (const t of ['pools', 'asig', 'sol', 'jira']) {
    await page.locator(`#nav [data-t=${t}]`).click();
    await page.waitForTimeout(200);
    const sobra = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(sobra, `pestaña ${t}`).toBeLessThanOrEqual(0);
  }
});
