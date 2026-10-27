#!/usr/bin/env node
'use strict';
// Aplica uno o más archivos SQL a DATABASE_URL SIN necesitar el cliente `psql` (los contenedores de CI mínimos no lo traen).
//   node scripts/aplicar-sql.js db/schema.sql db/seed.sql
// Con --reiniciar borra y recrea el esquema «public» antes (solo para bases de PRUEBAS desechables).
const fs = require('node:fs');
const { Client } = require('pg');

(async () => {
  const args = process.argv.slice(2);
  const reiniciar = args.includes('--reiniciar');
  const archivos = args.filter((a) => !a.startsWith('--'));
  if (!process.env.DATABASE_URL || !archivos.length) {
    console.error('Uso: DATABASE_URL=… node scripts/aplicar-sql.js [--reiniciar] archivo.sql…');
    process.exit(2);
  }
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    if (reiniciar) await c.query('drop schema public cascade; create schema public;');
    for (const f of archivos) {
      await c.query(fs.readFileSync(f, 'utf8'));
      console.log(`aplicado ${f}`);
    }
  } finally {
    await c.end();
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
