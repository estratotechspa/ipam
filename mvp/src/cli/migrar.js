'use strict';
// `npm run migrar` · aplica el esquema con el usuario migrador (DATABASE_URL_MIGRACION, o DATABASE_URL si falta).
const { config, validar } = require('../config');
const { crearLogger } = require('../adaptadores/log/logger');
const { migrar } = require('../adaptadores/persistencia/postgres/migraciones');

async function main() {
  const log = crearLogger({ nivel: config.log.nivel, base: { servicio: 'ipam-migrar' } });
  const { errores } = validar();
  const relevantes = errores.filter((e) => /DATABASE|TLS|bd/i.test(e));
  if (relevantes.length) { log.error('Configuración inválida', { errores: relevantes }); process.exitCode = 1; return; }
  try {
    const r = await migrar({ url: config.bd.urlMigracion, bd: config.bd, log });
    log.info('Migración terminada', r);
  } catch (e) {
    log.error('La migración falló', e);
    process.exitCode = 1;
  }
}
if (require.main === module) main();
module.exports = { main };
