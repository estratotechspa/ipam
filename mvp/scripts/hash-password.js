#!/usr/bin/env node
'use strict';
// Genera el hash scrypt para APP_PASS (modo Basic). La clave se lee de la entrada estándar o del primer argumento:
//   printf '%s' 'mi-clave' | node scripts/hash-password.js        (recomendado: no queda en el historial del shell)
//   node scripts/hash-password.js 'mi-clave'
// Imprime solo el hash (formato scrypt$N$r$p$sal$hash). No lo guardes en el repositorio: va en una variable de entorno o un secreto.
const { hashear } = require('../src/adaptadores/auth/contrasena');

async function leerEntrada() {
  if (process.argv[2]) return process.argv[2];
  if (process.stdin.isTTY) {
    console.error('Uso: printf %s "clave" | node scripts/hash-password.js');
    process.exit(2);
  }
  const partes = [];
  for await (const p of process.stdin) partes.push(p);
  return Buffer.concat(partes)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

leerEntrada().then(async (clave) => {
  if (clave.length < 12) {
    console.error('La clave debe tener al menos 12 caracteres.');
    process.exit(2);
  }
  console.log(await hashear(clave));
});
