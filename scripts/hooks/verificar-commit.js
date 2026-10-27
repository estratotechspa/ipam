#!/usr/bin/env node
"use strict";
// Verifica que el mensaje de commit siga Conventional Commits (https://www.conventionalcommits.org):
//     tipo(ámbito opcional)!: descripción corta        p. ej.  feat(reservas): agrega la expiración perezosa
// Lo ejecuta el hook commit-msg (lefthook) y el CI sobre los commits de la rama. Sin dependencias.
const fs = require("node:fs");

const TIPOS = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
];
const CABECERA = new RegExp(
  `^(${TIPOS.join("|")})(\\([a-z0-9._/-]+\\))?(!)?: \\S.{0,99}$`,
);
const AUTOMATICOS = [
  /^Merge (branch|pull request|remote-tracking branch|commit) /,
  /^Revert "/,
  /^(fixup|squash)! /,
];

/** @param {string} mensaje @returns {{ok: boolean, motivo?: string}} */
function verificar(mensaje) {
  const cabecera = String(mensaje).split("\n")[0].trim();
  if (!cabecera) return { ok: false, motivo: "el mensaje está vacío" };
  if (AUTOMATICOS.some((r) => r.test(cabecera))) return { ok: true };
  if (!CABECERA.test(cabecera)) {
    return {
      ok: false,
      motivo: `«${cabecera.slice(0, 80)}» no sigue Conventional Commits. Formato: tipo(ámbito opcional): descripción (tipos: ${TIPOS.join(", ")}; hasta 100 caracteres)`,
    };
  }
  return { ok: true };
}

if (require.main === module) {
  const archivo = process.argv[2];
  if (!archivo) {
    console.error("Uso: verificar-commit.js <archivo-con-el-mensaje>");
    process.exit(2);
  }
  const r = verificar(fs.readFileSync(archivo, "utf8"));
  if (!r.ok) {
    console.error(`✗ ${r.motivo}`);
    process.exit(1);
  }
}
module.exports = { verificar, TIPOS };
