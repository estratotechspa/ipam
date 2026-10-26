const { test, expect } = require('@playwright/test');
const { conectar, crearPool, borrarPools } = require('./fixtures');

const IDS = ['e2e-uso-bajo', 'e2e-uso-medio', 'e2e-uso-alto', 'e2e-mapa', 'e2e-pag', 'e2e-mod', 'e2e-sol'];
let db;

test.beforeAll(async () => {
  db = conectar();
  await borrarPools(db, IDS); // por si una corrida anterior quedó a medias
  // /28 = 16 direcciones: 8 → 50 %; 8+4 → 75 %; 8+4+2+1 → 93,8 %
  await crearPool(db, { id: 'e2e-uso-bajo', cidr: '10.240.0.0/28', asignaciones: [{ cidr: '10.240.0.0/29', vpc: 'uso-a' }] });
  await crearPool(db, { id: 'e2e-uso-medio', cidr: '10.241.0.0/28', asignaciones: [{ cidr: '10.241.0.0/29', vpc: 'uso-b' }, { cidr: '10.241.0.8/30', vpc: 'uso-c' }] });
  await crearPool(db, { id: 'e2e-uso-alto', cidr: '10.242.0.0/28', ambiente: 'prod', asignaciones: [
    { cidr: '10.242.0.0/29', vpc: 'uso-d' }, { cidr: '10.242.0.8/30', vpc: 'uso-e' }, { cidr: '10.242.0.12/31', vpc: 'uso-f' }, { cidr: '10.242.0.14/32', vpc: 'uso-g' }] });
  // /22 → 256 bloques /30 de 4 direcciones: el /24 cubre 64, el /31 deja uno parcial, 191 libres
  await crearPool(db, { id: 'e2e-mapa', cidr: '10.250.0.0/22', ambiente: 'qa', asignaciones: [{ cidr: '10.250.0.0/24', vpc: 'mapa-a', ticket: 'MAPA-1' }, { cidr: '10.250.2.0/31', vpc: 'mapa-b', ticket: 'MAPA-2' }] });
  await crearPool(db, { id: 'e2e-pag', cidr: '10.251.0.0/20', ambiente: 'pre', asignaciones: Array.from({ length: 60 }, (_, i) => ({ cidr: `10.251.0.${i * 16}/28`.replace(/10\.251\.0\.(\d+)\//, (_m, n) => `10.251.${Math.floor(n / 256)}.${n % 256}/`), vpc: `pag-${String(i).padStart(2, '0')}`, ticket: `PAG-${String(i).padStart(2, '0')}` })) });
  await crearPool(db, { id: 'e2e-mod', cidr: '10.253.0.0/24', asignaciones: [{ cidr: '10.253.0.0/28', vpc: 'modal-uno', ticket: 'MOD-1' }] });
  await crearPool(db, { id: 'e2e-sol', cidr: '10.252.0.0/24' });
});
test.afterAll(async () => { await borrarPools(db, IDS); await db.end(); });

// ---------- Pools ----------
test.describe('pools', () => {
  test('barras de uso: porcentaje numérico y color por umbral', async ({ page }) => {
    await page.goto('/#pools');
    for (const [id, nivel, pct] of [['e2e-uso-bajo', 'bajo', '50,0 %'], ['e2e-uso-medio', 'medio', '75,0 %'], ['e2e-uso-alto', 'alto', '93,8 %']]) {
      const fila = page.locator('tr', { has: page.getByRole('button', { name: id, exact: true }) });
      await expect(fila.locator('.uso-pct')).toHaveText(pct);
      await expect(fila.locator(`.bar i.uso-${nivel}`)).toBeVisible();
      await expect(fila.locator('.bar')).toHaveAttribute('aria-label', new RegExp(`${pct}, uso ${nivel}`));
    }
    // en uso alto el color no va solo: lleva un icono de alerta
    await expect(page.locator('tr', { has: page.getByRole('button', { name: 'e2e-uso-alto', exact: true }) }).locator('.uso-pct svg')).toHaveCount(1);
    await expect(page.locator('tr', { has: page.getByRole('button', { name: 'e2e-uso-bajo', exact: true }) }).locator('.uso-pct svg')).toHaveCount(0);
    // los colores de cada umbral son distintos entre sí
    const color = (n) => page.locator(`.bar i.uso-${n}`).first().evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(new Set([await color('bajo'), await color('medio'), await color('alto')]).size).toBe(3);
  });

  test('KPIs: «Pools sobre 80 %» y «Espacio libre» en lugar de «Solapamientos: 0»', async ({ page }) => {
    await page.goto('/#pools');
    const cuerpo = page.locator('#pools');
    await expect(cuerpo.getByText('Pools sobre 80 %')).toBeVisible();
    await expect(cuerpo.getByText('Espacio libre (direcciones)')).toBeVisible();
    await expect(cuerpo.getByText(/Solapamientos \(/)).toHaveCount(0);
    await expect(cuerpo.locator('.nota')).toContainText('restricción de exclusión');
    // el KPI coincide con las barras que muestra la misma tabla
    const usos = (await page.locator('#pools .uso-pct').allInnerTexts()).map((t) => parseFloat(t.replace(',', '.')));
    const kpis = Object.fromEntries(await page.locator('#pools .kpi').evaluateAll((els) => els.map((e) => [e.nextElementSibling.textContent, e.textContent.trim()])));
    expect(Number(kpis['Pools sobre 80 %'])).toBe(usos.filter((u) => u > 80).length);
    expect(kpis['Espacio libre (direcciones)']).toMatch(/^[\d.]+$/);
  });

  test('clic en un pool: detalle con mapa de bloques, leyenda, tabla y navegación con «atrás»', async ({ page }) => {
    await page.goto('/#pools');
    await page.getByRole('button', { name: 'e2e-mapa', exact: true }).click();
    await expect(page).toHaveURL(/#pools\/e2e-mapa$/);
    await expect(page.getByRole('heading', { name: /e2e-mapa/ })).toBeVisible();
    await expect(page.locator('.mapa .bloque')).toHaveCount(256);
    await expect(page.locator('.mapa .bloque-ocupado')).toHaveCount(64);
    await expect(page.locator('.mapa .bloque-parcial')).toHaveCount(1);
    await expect(page.locator('.mapa .bloque-libre')).toHaveCount(191);
    const leyenda = page.locator('.leyenda');
    await expect(leyenda).toContainText('Libre (191)');
    await expect(leyenda).toContainText('Parcial (1)');
    await expect(leyenda).toContainText('Ocupado (64)');
    await expect(page.locator('.mapa')).toHaveAttribute('aria-label', /256 bloques \/30: 191 libres, 1 parciales, 64 ocupados/);
    // el mapa no depende solo del color: parcial y ocupado se pintan distinto (fondo lleno vs. rayado)
    const fondo = (sel) => page.locator(sel).first().evaluate((e) => getComputedStyle(e).backgroundImage + '|' + getComputedStyle(e).backgroundColor);
    expect(new Set([await fondo('.mapa .bloque-libre'), await fondo('.mapa .bloque-parcial'), await fondo('.mapa .bloque-ocupado')]).size).toBe(3);

    await page.locator('.mapa .bloque').first().hover();
    await expect(page.locator('#mapa-detalle')).toContainText('10.250.0.0/30 · ocupado · mapa-a (10.250.0.0/24, MAPA-1)');
    await page.locator('.mapa .bloque-parcial').hover();
    await expect(page.locator('#mapa-detalle')).toContainText('parcialmente ocupado · mapa-b');

    const tabla = page.getByRole('region', { name: 'Asignaciones de e2e-mapa' });
    await expect(tabla.locator('tbody tr')).toHaveCount(2);
    await expect(tabla).toContainText('10.250.0.0/24');
    await expect(page.locator('.kpi').first()).toHaveText('25,2 %'); // (256 + 2) de 1.024 direcciones

    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Estado de pools' })).toBeVisible();
    await page.goForward();
    await expect(page.locator('.mapa .bloque')).toHaveCount(256);
    await page.getByRole('link', { name: 'Volver a pools' }).click();
    await expect(page.getByRole('heading', { name: 'Estado de pools' })).toBeVisible();
  });

  test('enlace directo a un pool y botón para solicitar en él; un pool inexistente avisa', async ({ page }) => {
    await page.goto('/#pools/e2e-mapa');
    await expect(page.locator('.mapa .bloque')).toHaveCount(256);
    await page.getByRole('link', { name: /Solicitar un segmento aquí/ }).click();
    await expect(page.locator('#s-pool')).toHaveValue('e2e-mapa');
    await page.goto('/#pools/no-existe');
    await expect(page.getByRole('alert')).toContainText('no existe');
  });
});

// ---------- Asignaciones ----------
test.describe('asignaciones', () => {
  test('búsqueda, filtros, orden por columna y paginación contra la API', async ({ page }) => {
    await page.goto('/#asig');
    await page.fill('#a-q', 'pag-');
    const resumen = page.locator('#a-pag');
    await expect(resumen).toContainText('Mostrando 1–25 de 60');
    await expect(page.locator('#a-tabla tbody tr')).toHaveCount(25);
    await expect(page.locator('#a-ant')).toBeDisabled();
    await page.click('#a-sig');
    await expect(resumen).toContainText('Mostrando 26–50 de 60');
    await expect(resumen).toContainText('Página 2 de 3');
    await page.click('#a-sig');
    await expect(resumen).toContainText('Mostrando 51–60 de 60');
    await expect(page.locator('#a-tabla tbody tr')).toHaveCount(10);
    await expect(page.locator('#a-sig')).toBeDisabled();
    await page.click('#a-ant');
    await expect(resumen).toContainText('Mostrando 26–50 de 60');

    // orden por columna: ascendente, descendente, y vuelve a la primera página
    await page.getByRole('button', { name: 'Proyecto / VPC' }).click();
    const th = page.getByRole('columnheader', { name: 'Proyecto / VPC' });
    await expect(th).toHaveAttribute('aria-sort', 'ascending');
    await expect(resumen).toContainText('Mostrando 1–25 de 60');
    await expect(page.locator('#a-tabla tbody tr').first()).toContainText('pag-00');
    await page.getByRole('button', { name: 'Proyecto / VPC' }).click();
    await expect(th).toHaveAttribute('aria-sort', 'descending');
    await expect(page.locator('#a-tabla tbody tr').first()).toContainText('pag-59');
    await expect(page.getByRole('columnheader', { name: 'Pool' })).toHaveAttribute('aria-sort', 'none');

    // filtros por pool y por ambiente (e2e-pag es «pre»)
    await page.fill('#a-q', '');
    await page.selectOption('#a-pool', 'e2e-pag');
    await expect(resumen).toContainText('de 60');
    await page.selectOption('#a-amb', 'prod');
    await expect(page.locator('#a-tabla .vacio')).toContainText('Ninguna asignación coincide');
    await page.selectOption('#a-amb', 'pre');
    await expect(resumen).toContainText('de 60');

    // la búsqueda y los filtros se conservan al cambiar de pestaña; «Limpiar filtros» los quita
    await page.fill('#a-q', 'pag-07');
    await expect(resumen).toContainText('Mostrando 1–1 de 1');
    await page.locator('#nav [data-t=pools]').click();
    await page.locator('#nav [data-t=asig]').click();
    await expect(page.locator('#a-q')).toHaveValue('pag-07');
    await expect(page.locator('#a-pool')).toHaveValue('e2e-pag');
    await page.click('#a-limpiar');
    await expect(page.locator('#a-q')).toHaveValue('');
    await expect(page.locator('#a-pool')).toHaveValue('');
    await expect(resumen).not.toContainText('de 1');
  });

  test('sin resultados: mensaje claro en lugar de una tabla vacía', async ({ page }) => {
    await page.goto('/#asig');
    await page.fill('#a-q', 'no-existe-este-texto');
    await expect(page.locator('#a-tabla .vacio')).toContainText('Ninguna asignación coincide con la búsqueda');
    await expect(page.locator('#a-pag')).toContainText('Sin resultados');
    await expect(page.locator('#a-tabla table')).toHaveCount(0);
  });

  test('«Liberar» abre un diálogo accesible: foco atrapado, Esc cancela, confirmar libera con aviso; sin alert/confirm nativos', async ({ page }) => {
    const nativos = [];
    page.on('dialog', (d) => { nativos.push(d.message()); d.dismiss(); });
    await page.goto('/#asig');
    await page.fill('#a-q', 'modal-uno');
    const abrir = page.locator('tr', { hasText: 'modal-uno' }).getByRole('button', { name: 'Liberar' });
    await abrir.click();
    const dialogo = page.getByRole('dialog');
    await expect(dialogo).toBeVisible();
    await expect(dialogo).toHaveAttribute('aria-modal', 'true');
    await expect(dialogo.getByRole('heading')).toHaveText('¿Liberar 10.253.0.0/28?');
    await expect(dialogo).toContainText('quedará disponible');
    await expect(page.locator('main')).toHaveJSProperty('inert', true);

    // foco inicial en «Cancelar» (acción destructiva) y Tab no sale del diálogo
    await expect(dialogo.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialogo.getByRole('button', { name: 'Liberar segmento' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialogo.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialogo.getByRole('button', { name: 'Liberar segmento' })).toBeFocused();

    // Esc cierra sin liberar y devuelve el foco a quien lo abrió
    await page.keyboard.press('Escape');
    await expect(dialogo).toHaveCount(0);
    await expect(abrir).toBeFocused();
    await expect(page.locator('main')).toHaveJSProperty('inert', false);
    await expect(page.locator('tr', { hasText: 'modal-uno' })).toHaveCount(1);

    // clic fuera del diálogo también cancela
    await abrir.click();
    await page.mouse.click(5, 5);
    await expect(dialogo).toHaveCount(0);

    // confirmar libera y avisa con un toast
    await abrir.click();
    await dialogo.getByRole('button', { name: 'Liberar segmento' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Segmento 10.253.0.0/28 liberado' })).toBeVisible();
    await expect(page.locator('tr', { hasText: 'modal-uno' })).toHaveCount(0);
    expect(nativos, 'no se usan alert() ni confirm()').toEqual([]);
  });
});

// ---------- Solicitar ----------
test.describe('solicitar', () => {
  test('sin valores de demo precargados y sin la ayuda de «prueba un CIDR que choque»', async ({ page }) => {
    await page.goto('/#sol');
    await expect(page.locator('#s-vpc')).toHaveValue('');
    await expect(page.locator('#s-cidr')).toHaveValue('');
    // ningún pool preseleccionado «de demo»: queda el primero de la lista
    await expect(page.locator('#s-pool')).toHaveValue(await page.locator('#s-pool option').first().getAttribute('value'));
    await expect(page.locator('#sol')).not.toContainText('Prueba un CIDR');
    await expect(page.locator('#sol')).not.toContainText('vpc-pagos');
  });

  test('con DEMO=true (/api/config) aparece la ayuda de demostración', async ({ page }) => {
    await page.route('**/api/config', async (ruta) => {
      const r = await ruta.fetch();
      await ruta.fulfill({ response: r, json: { ...(await r.json()), demo: true } });
    });
    await page.goto('/#sol');
    await expect(page.locator('#s-res')).toContainText('Demo: prueba un CIDR que choque');
  });

  test('valida el CIDR mientras se escribe: formato, alineación y pool', async ({ page }) => {
    await page.goto('/#sol');
    await page.selectOption('#s-pool', 'gke-pods-prod');
    const msg = page.locator('#s-cidr-msg');
    const entrada = page.locator('#s-cidr');
    const enviar = page.locator('#s-go');
    await expect(msg).toHaveText('');
    await expect(enviar).toBeEnabled();

    await entrada.fill('hola');
    await expect(msg).toContainText('Formato inválido');
    await expect(entrada).toHaveAttribute('aria-invalid', 'true');
    await expect(entrada).toHaveAttribute('aria-describedby', 's-cidr-msg');
    await expect(enviar).toBeDisabled();

    await entrada.fill('10.64.8.0');
    await expect(msg).toContainText('Falta la máscara');
    await entrada.fill('10.64.9.0/22');
    await expect(msg).toContainText('no está alineado');
    await expect(msg).toContainText('¿Quisiste decir 10.64.8.0/22?');
    await entrada.fill('11.0.0.0/22');
    await expect(msg).toContainText('queda fuera del pool 10.64.0.0/12');
    await expect(enviar).toBeDisabled();

    await entrada.fill('10.64.16.0/22');
    await expect(msg).toContainText('10.64.16.0/22 · 1.024 direcciones');
    await expect(entrada).not.toHaveAttribute('aria-invalid', 'true');
    await expect(enviar).toBeEnabled();
    await entrada.fill('');
    await expect(msg).toHaveText('');
    // el mensaje de error es legible (contraste) y lleva icono
    await entrada.fill('hola');
    await expect(msg.locator('svg')).toHaveCount(1);
  });

  test('conserva lo escrito al cambiar de pestaña', async ({ page }) => {
    await page.goto('/#sol');
    await page.fill('#s-vpc', 'proyecto-persistente');
    await page.fill('#s-cidr', '10.64.16.0/22');
    await page.selectOption('#s-len', '26');
    await page.locator('#nav [data-t=pools]').click();
    await expect(page.getByRole('heading', { name: 'Estado de pools' })).toBeVisible();
    await page.locator('#nav [data-t=sol]').click();
    await expect(page.locator('#s-vpc')).toHaveValue('proyecto-persistente');
    await expect(page.locator('#s-cidr')).toHaveValue('10.64.16.0/22');
    await expect(page.locator('#s-len')).toHaveValue('26');
  });

  test('el mensaje de éxito dice «Ticket NET-xxx generado» y solo menciona a Jira si está activo', async ({ page }) => {
    await page.goto('/#sol');
    await page.selectOption('#s-pool', 'e2e-sol');
    await page.fill('#s-vpc', 'sol-sin-jira');
    await page.selectOption('#s-len', '28');
    await page.click('#s-go');
    const ok = page.locator('#s-res [role=status]').first();
    await expect(ok).toContainText('Asignado 10.252.0.0/28 en e2e-sol para sol-sin-jira');
    await expect(ok).toContainText(/Ticket NET-\d+ generado\./);
    await expect(ok).not.toContainText('Jira');
    await expect(page.locator('#toasts')).toContainText('asignado');

    // con Jira activo (respuesta simulada del estado) el mensaje explica que el ticket se crea en segundo plano
    await page.route('**/api/jira/estado', (ruta) => ruta.fulfill({ json: { activa: true, faltantes: [], simulador: false } }));
    await page.locator('#nav [data-t=pools]').click();
    await page.locator('#nav [data-t=sol]').click();
    await page.selectOption('#s-pool', 'e2e-sol');
    await page.fill('#s-vpc', 'sol-con-jira');
    await page.selectOption('#s-len', '28');
    await page.click('#s-go');
    await expect(page.locator('#s-res [role=status]').first()).toContainText('El ticket de Jira se crea en segundo plano');
    await expect(page.locator('#s-res')).not.toContainText('Jira creó');
  });

  test('pide el proyecto/VPC antes de enviar y muestra el espacio libre del pool', async ({ page }) => {
    await page.goto('/#sol');
    await expect(page.locator('#s-pool-info')).toContainText('direcciones libres de');
    await page.click('#s-go');
    await expect(page.locator('#s-res [role=alert]')).toContainText('Indica el proyecto');
    await expect(page.locator('#s-vpc')).toBeFocused();
  });
});

// ---------- Jira ----------
test.describe('jira', () => {
  test('muestra primero el estado real y los eventos; el diagrama y el simulador van plegados en «Cómo funciona»', async ({ page }) => {
    await db.query("insert into eventos (tipo, detalle) values ('jira_error', $1)", [JSON.stringify({ ticket: 'E2E-JIRA', motivo: 'Jira POST /rest/api/3/issue → 500' })]);
    await page.goto('/#jira');
    await expect(page.getByRole('heading', { name: 'Integración con Jira' })).toBeVisible();
    const tarjetas = page.locator('#jira > .card, #jira > details');
    await expect(tarjetas.nth(0)).toContainText('Estado');
    await expect(tarjetas.nth(0)).toContainText('Desactivada');
    await expect(tarjetas.nth(1)).toContainText('Últimos eventos');
    await expect(tarjetas.nth(2)).toContainText('Cómo funciona');
    const fila = page.locator('tr', { hasText: 'E2E-JIRA' });
    await expect(fila).toContainText('Error al hablar con Jira');
    await expect(fila).toContainText('→ 500');

    const como = page.locator('details.plegable');
    await expect(como).not.toHaveAttribute('open', '');
    await expect(page.getByRole('button', { name: 'Enviar webhook' })).toBeHidden();
    await como.locator('summary').click();
    await expect(como).toHaveAttribute('open', '');
    await expect(como.locator('.flow')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Enviar webhook' })).toBeVisible();
    await db.query("delete from eventos where detalle->>'ticket' = 'E2E-JIRA'");
  });

  test('integración activa pero incompleta: lista las variables que faltan', async ({ page }) => {
    await page.route('**/api/jira/estado', (ruta) => ruta.fulfill({ json: { activa: true, faltantes: ['JIRA_EMAIL', 'JIRA_API_TOKEN'], simulador: true } }));
    await page.goto('/#jira');
    const estado = page.locator('#jira > .card').first();
    await expect(estado).toContainText('Activa, incompleta');
    await expect(estado.getByRole('alert')).toContainText('JIRA_EMAIL');
    await expect(estado.getByRole('alert')).toContainText('JIRA_API_TOKEN');
  });

  test('integración activa y completa; y sin simulador (producción) se explica por qué falta', async ({ page }) => {
    await page.route('**/api/jira/estado', (ruta) => ruta.fulfill({ json: { activa: true, faltantes: [], simulador: false } }));
    await page.goto('/#jira');
    await expect(page.locator('#jira > .card').first()).toContainText('Activa');
    await expect(page.locator('#jira > .card').first()).not.toContainText('incompleta');
    await page.locator('details.plegable summary').click();
    await expect(page.getByRole('button', { name: 'Enviar webhook' })).toHaveCount(0);
    await expect(page.locator('details.plegable')).toContainText('ENABLE_SIMULADOR=true');
  });

  test('el simulador envía un webhook firmado y deja el resultado en los eventos', async ({ page }) => {
    await page.goto('/#jira');
    await page.locator('details.plegable summary').click();
    await page.selectOption('#j-amb', 'qa');
    await page.selectOption('#j-tipo', 'Nodos');
    await page.selectOption('#j-len', '28');
    await page.fill('#j-vpc', 'e2e-simulado');
    await page.getByRole('button', { name: 'Enviar webhook' }).click();
    await expect(page.locator('#toasts')).toContainText('Webhook procesado');
    await expect(page.locator('details.plegable')).toHaveAttribute('open', '');
    await expect(page.locator('tr', { hasText: 'Webhook recibido (simulado)' }).first()).toBeVisible();
    for (const a of await (await page.request.get('/api/asignaciones?q=e2e-simulado')).json()) {
      await page.request.delete(`/api/asignaciones/${a.id}`, { headers: { 'X-Requested-With': 'ipam' } });
    }
  });
});
