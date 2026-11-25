'use strict';
// `npm run purgar [-- --simular]` · borra los eventos más antiguos que RETENCION_DIAS (365 por defecto; 0 = conservar todo).
// Usa el usuario migrador (DATABASE_URL_MIGRACION, o DATABASE_URL si falta): la aplicación no puede borrar eventos. La auditoría no se toca.
const { config, validarParaMigrar } = require('../config');
const { crearLogger } = require('../adaptadores/log/logger');
const { purgarEventos } = require('../adaptadores/persistencia/postgres/retencion');

async function main(argv = process.argv.slice(2)) {
  const log = crearLogger({ nivel: config.log.nivel, base: { servicio: 'ipam-purgar' } });
  const { errores } = validarParaMigrar();
  if (errores.length) {
    log.error('Configuración inválida', { errores });
    process.exitCode = 1;
    return;
  }
  const dias = config.retencion.dias;
  if (dias === 0) {
    log.info('RETENCION_DIAS=0: se conserva todo, no se purga nada');
    return;
  }
  try {
    const r = await purgarEventos({ url: config.bd.urlMigracion, bd: config.bd, dias, simular: argv.includes('--simular'), log });
    log.info(r.simulado ? 'Simulación: no se borró nada' : 'Purga terminada', r);
  } catch (e) {
    log.error('La purga falló', e);
    process.exitCode = 1;
  }
}
if (require.main === module) main();
module.exports = { main };
