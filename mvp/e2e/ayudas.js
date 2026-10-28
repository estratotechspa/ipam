// Ayudas compartidas por las pruebas de navegador.
const { expect } = require('@playwright/test');

// El diálogo de confirmación de la interfaz (reemplaza a confirm() y prompt() del navegador).
const dialogo = (page) => page.locator('dialog.confirmar');

/** Acepta el diálogo de confirmación: comprueba su texto (opcional), escribe el motivo si lo pide y pulsa el botón indicado (con `encadenado`, sin esperar a que no quede ningún diálogo). */
async function aceptar(page, boton, { contiene, motivo, encadenado } = {}) {
  const d = dialogo(page);
  await expect(d).toBeVisible();
  if (contiene) await expect(d).toContainText(contiene);
  if (motivo) await d.getByLabel('Motivo').fill(motivo);
  await d.getByRole('button', { name: boton, exact: true }).click();
  // `encadenado`: este diálogo abre otro enseguida (la segunda confirmación de una liberación), así que no queda en cero.
  if (!encadenado) await expect(d).toHaveCount(0);
}

/** Cancela el diálogo de confirmación (comprobando su texto si se indica). */
async function cancelar(page, { contiene } = {}) {
  const d = dialogo(page);
  await expect(d).toBeVisible();
  if (contiene) await expect(d).toContainText(contiene);
  await d.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(d).toHaveCount(0);
}

/** Segunda confirmación de una liberación definitiva: comprueba el aviso, exige escribir el CIDR y confirma. */
async function confirmarLiberacion(page, cidr) {
  const d = dialogo(page);
  await expect(d).toBeVisible();
  await expect(d).toContainText('Última confirmación');
  await expect(d).toContainText(cidr);
  await d.getByLabel(`Escribe ${cidr} para confirmar`).fill(cidr);
  await d.getByRole('button', { name: 'Sí, liberar ahora', exact: true }).click();
  await expect(d).toHaveCount(0);
}

module.exports = { dialogo, aceptar, cancelar, confirmarLiberacion };
