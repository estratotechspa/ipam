// Ayudas compartidas por las pruebas de navegador.
const { expect } = require('@playwright/test');

// El diálogo de confirmación de la interfaz (reemplaza a confirm() y prompt() del navegador).
const dialogo = (page) => page.locator('dialog.confirmar');

/** Acepta el diálogo de confirmación: comprueba su texto (opcional), escribe el motivo si lo pide y pulsa el botón indicado. */
async function aceptar(page, boton, { contiene, motivo } = {}) {
  const d = dialogo(page);
  await expect(d).toBeVisible();
  if (contiene) await expect(d).toContainText(contiene);
  if (motivo) await d.getByLabel('Motivo').fill(motivo);
  await d.getByRole('button', { name: boton, exact: true }).click();
  await expect(d).toHaveCount(0);
}

/** Cancela el diálogo de confirmación (comprobando su texto si se indica). */
async function cancelar(page, { contiene } = {}) {
  const d = dialogo(page);
  await expect(d).toBeVisible();
  if (contiene) await expect(d).toContainText(contiene);
  await d.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(d).toHaveCount(0);
}

module.exports = { dialogo, aceptar, cancelar };
