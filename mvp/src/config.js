'use strict';
// Configuración del IPAM. ÚNICO lugar del código que lee `process.env` (lo comprueba scripts/verificar-portabilidad.sh).
//
//  - Todo se configura por variables de entorno (principio «12 factores»): la misma imagen sirve en dev, qa, pre y prod.
//  - Toda variable acepta también la forma NOMBRE_FILE: ruta de un archivo cuyo contenido es el valor. Así funcionan igual
//    los secretos montados por Kubernetes, Secret Manager (GCP), AWS Secrets Manager, Azure Key Vault o Docker secrets.
//    Si existen las dos formas, gana la variable directa y `validar()` lo avisa.
//  - Los valores se leen en el momento de usarlos (no se congelan al cargar el módulo). La validación completa ocurre al
//    arrancar con `validarOFallar()`, que reúne TODOS los problemas en un solo mensaje claro.
const fs = require('node:fs');

class ErrorDeConfiguracion extends Error {
  constructor(problemas) {
    super(`Configuración inválida:\n - ${problemas.join('\n - ')}`);
    this.name = 'ErrorDeConfiguracion';
    this.problemas = problemas;
  }
}

const DEFINICIONES = new Map();
/**
 * Registra una variable. `secreta` = nunca se muestra en logs ni en mensajes de error.
 * @param {string} nombre @param {'texto'|'entero'|'booleano'|'lista'} tipo
 */
function def(nombre, tipo, defecto, descripcion, extra = {}) {
  DEFINICIONES.set(nombre, { nombre, tipo, defecto, descripcion, obligatoria: false, secreta: false, ejemplo: '', ...extra });
}

// ---------- Catálogo de variables (de aquí sale docs/CONFIGURACION.md) ----------
// Proceso
def('NODE_ENV', 'texto', 'development', 'Entorno. Con «production» se activan las protecciones de arranque seguro.', { ejemplo: 'production' });
def('PORT', 'entero', 8080, 'Puerto HTTP en el que escucha el servicio.', { min: 1, max: 65535 });
def('ROL', 'texto', 'todos', 'Qué hace esta réplica: «api» (solo HTTP), «worker» (solo barredor) o «todos».', { opciones: ['api', 'worker', 'todos'] });
def('LOG_LEVEL', 'texto', 'info', 'Nivel de log: debug, info, warn o error.', { opciones: ['debug', 'info', 'warn', 'error'] });
def(
  'TRUST_PROXY',
  'texto',
  '',
  'Saltos de proxy delante de la app (número). Hace que la IP del cliente, las cookies Secure y el rate limit funcionen tras un balanceador.',
  { ejemplo: '1' },
);
def('JSON_LIMIT', 'texto', '100kb', 'Tamaño máximo del cuerpo JSON de las peticiones normales.', { ejemplo: '100kb' });
def('JSON_LIMIT_IMPORTAR', 'texto', '5mb', 'Tamaño máximo del cuerpo en POST /api/importar (respaldos).', { ejemplo: '5mb' });
def('HSTS', 'booleano', false, 'Envía Strict-Transport-Security. Actívalo solo si el acceso es siempre por HTTPS.');
def('PUBLIC_URL', 'texto', '', 'URL pública del IPAM (base del login OIDC y de los enlaces). Obligatoria con OIDC.', {
  ejemplo: 'https://ipam.empresa.example',
});
def('APAGADO_TIMEOUT_MS', 'entero', 15000, 'Tiempo máximo para terminar las peticiones en curso al recibir SIGTERM.', { min: 100, max: 600000 });
def('SOLICITUD_TIMEOUT_MS', 'entero', 30000, 'Tiempo máximo que el servidor espera para recibir una petición completa.', { min: 1000, max: 600000 });

// Base de datos (recurso adjunto)
def('DATABASE_URL', 'texto', '', 'Cadena de conexión a PostgreSQL de la aplicación (usuario con permisos DML).', {
  obligatoria: true,
  secreta: true,
  ejemplo: 'postgres://ipam_app:CLAVE@host:5432/ipam?sslmode=require',
});
def('DATABASE_URL_MIGRACION', 'texto', '', 'Cadena de conexión del usuario migrador (DDL). Solo la usa `npm run migrar`. Si falta, se usa DATABASE_URL.', {
  secreta: true,
  ejemplo: 'postgres://ipam_migrador:CLAVE@host:5432/ipam',
});
def('DATABASE_SCHEMA', 'texto', 'public', 'Esquema de PostgreSQL donde viven las tablas del IPAM.', { ejemplo: 'ipam' });
def(
  'DATABASE_SSL',
  'texto',
  '',
  'TLS hacia la base: «disable», «require» (cifra sin verificar) o «verify-full» (verifica el certificado). Vacío = lo que diga DATABASE_URL (sslmode).',
  { opciones: ['', 'disable', 'require', 'verify-full'] },
);
def('DATABASE_SSL_CA', 'texto', '', 'Certificado de la autoridad (PEM) para verify-full. Acepta la forma _FILE.', { secreta: false });
def('DB_POOL_MAX', 'entero', 10, 'Máximo de conexiones del pool por réplica.', { min: 1, max: 200 });
def('DB_CONNECT_TIMEOUT_MS', 'entero', 5000, 'Tiempo máximo para abrir una conexión a la base.', { min: 100, max: 120000 });
def('DB_STATEMENT_TIMEOUT_MS', 'entero', 15000, 'Tiempo máximo de una consulta (statement_timeout).', { min: 100, max: 600000 });
def('DB_IDLE_TIMEOUT_MS', 'entero', 30000, 'Tiempo tras el cual se cierra una conexión ociosa.', { min: 1000, max: 3600000 });
def(
  'MIGRAR_AL_ARRANCAR',
  'booleano',
  false,
  'EXCEPCIÓN: aplica el esquema al arrancar (para entornos sin job previo, p. ej. el POC). Por defecto la app NO toca el esquema.',
);

// Autenticación
def('ALLOW_ANONYMOUS', 'booleano', false, 'Permite arrancar en producción sin OIDC ni Basic (acceso abierto como admin). Solo para demos.');
def('APP_USER', 'texto', '', 'Usuario del modo Basic (un solo usuario, rol admin).', { ejemplo: 'admin' });
def('APP_PASS', 'texto', '', 'Contraseña del modo Basic. Acepta texto plano o un hash `scrypt$…` (recomendado; ver `npm run hash-password`).', {
  secreta: true,
});
def('SESSION_SECRET', 'texto', '', 'Clave (≥ 32 caracteres) con la que se firma la cookie de sesión OIDC.', { secreta: true });
def('SESSION_HORAS', 'entero', 8, 'Duración de la sesión OIDC.', { min: 1, max: 720 });
def('COOKIE_SECURE', 'texto', 'auto', 'Atributo Secure de las cookies: «auto» (si PUBLIC_URL es https o la petición llegó por HTTPS), «true» o «false».', {
  opciones: ['auto', 'true', 'false'],
});
def('OIDC_ISSUER', 'texto', '', 'URL del emisor OpenID Connect (Google, Entra, Okta, Keycloak…). Vacío = sin OIDC.', {
  ejemplo: 'https://accounts.google.com',
});
def('OIDC_CLIENT_ID', 'texto', '', 'Identificador del cliente OIDC.');
def('OIDC_CLIENT_SECRET', 'texto', '', 'Secreto del cliente OIDC.', { secreta: true });
def('OIDC_SCOPES', 'texto', 'openid email profile', 'Alcances solicitados al proveedor.');
def('OIDC_ALLOW_INSECURE', 'booleano', false, 'Permite un emisor OIDC por HTTP. Solo para pruebas.');
def('OIDC_ALLOWED_DOMAINS', 'lista', [], 'Dominios de correo permitidos (separados por coma). Vacío = cualquiera.', { ejemplo: 'empresa.example' });
def('OIDC_ADMIN_EMAILS', 'lista', [], 'Correos con rol admin siempre (evita quedar fuera).');
def('OIDC_REQUESTER_EMAILS', 'lista', [], 'Correos con rol solicitante.');
def('OIDC_READER_EMAILS', 'lista', [], 'Correos con rol lector.');
def('OIDC_GROUPS_CLAIM', 'texto', 'groups', 'Nombre del claim con los grupos del usuario.');
def('OIDC_ADMIN_GROUPS', 'lista', [], 'Grupos con rol admin.');
def('OIDC_REQUESTER_GROUPS', 'lista', [], 'Grupos con rol solicitante.');
def('OIDC_READER_GROUPS', 'lista', [], 'Grupos con rol lector.');
def('OIDC_DEFAULT_ROLE', 'texto', 'lector', 'Rol de quien no coincide con nada. «ninguno» = solo entran los mapeados.');
def('TOKEN_VIDA_DIAS', 'entero', 90, 'Vigencia por defecto de un token de servicio nuevo.', { min: 1, max: 365 });

// Reservas
def('RESERVA_TTL_HORAS', 'entero', 24, 'Vigencia por defecto de una reserva sin confirmar.', { min: 1, max: 720 });
def('RESERVA_TTL_MAX_HORAS', 'entero', 72, 'Vigencia máxima que se puede pedir para una reserva.', { min: 1, max: 720 });
def(
  'CONFIRMACION_EXIGE_APROBADOR',
  'booleano',
  true,
  'Un token de servicio debe indicar quién aprobó (aprobado_por) y la referencia (MR) al confirmar. Regla human-in-the-loop.',
);
def('BARREDOR_INTERVALO_SEGUNDOS', 'entero', 60, 'Cada cuánto corre el barredor (limpia reservas vencidas y contadores).', { min: 5, max: 3600 });

// Límites
def('RATE_LIMIT_POR_MINUTO', 'entero', 120, 'Peticiones de lectura por minuto por actor (token o usuario).', { min: 1, max: 1000000 });
def('RATE_LIMIT_ESCRITURA_POR_MINUTO', 'entero', 30, 'Peticiones de escritura por minuto por actor.', { min: 1, max: 1000000 });
def('RATE_LIMIT_IP_POR_MINUTO', 'entero', 600, 'Peticiones por minuto por dirección IP (suma de actores detrás de un mismo NAT).', { min: 1, max: 10000000 });
def('RATE_LIMIT_AUTH_FALLOS_POR_MINUTO', 'entero', 10, 'Intentos de autenticación fallidos por minuto por IP (freno a la fuerza bruta).', {
  min: 1,
  max: 100000,
});
def('CUOTA_RESERVAS_POR_TOKEN', 'entero', 20, 'Reservas «reservada» vigentes simultáneas por token (se puede fijar otra al crearlo).', { min: 1, max: 100000 });
def('LIMITE_ALMACEN', 'texto', 'postgres', 'Dónde se cuentan las peticiones: «postgres» (varias réplicas) o «memoria» (solo pruebas).', {
  opciones: ['postgres', 'memoria'],
});

// Métricas y eventos
def('METRICS_TOKEN', 'texto', '', 'Token de lectura para GET /metrics (Authorization: Bearer). Sin token ni redes permitidas, /metrics queda deshabilitado.', {
  secreta: true,
});
def('METRICS_ALLOW_CIDRS', 'lista', [], 'Redes IPv4 (CIDR) desde las que se puede leer /metrics.', { ejemplo: '10.0.0.0/8' });
def('EVENTOS_PUBLICADORES', 'lista', ['log'], 'Adaptadores de eventos activos: «log» y/o «webhook».', { ejemplo: 'log,webhook' });
def('EVENTOS_WEBHOOK_URL', 'texto', '', 'Destino del webhook saliente de eventos.', { ejemplo: 'https://eventos.empresa.example/ipam' });
def('EVENTOS_WEBHOOK_SECRET', 'texto', '', 'Clave con la que se firma (HMAC-SHA256) cada evento saliente.', { secreta: true });
def('EVENTOS_WEBHOOK_PERMITIR_HOSTS', 'lista', [], 'Hosts a los que se permite llegar aunque resuelvan a una dirección privada (lista explícita anti-SSRF).');
def('EVENTOS_WEBHOOK_TIMEOUT_MS', 'entero', 5000, 'Tiempo máximo de cada intento del webhook.', { min: 100, max: 60000 });
def('EVENTOS_WEBHOOK_REINTENTOS', 'entero', 3, 'Intentos máximos del webhook ante errores transitorios.', { min: 1, max: 10 });

// Trazas (OpenTelemetry), apagadas por defecto
def('OTEL_TRACES_EXPORTER', 'texto', 'none', 'Exportador de trazas: «none» (apagado) u «otlp».', { opciones: ['none', 'otlp'] });
def('OTEL_EXPORTER_OTLP_ENDPOINT', 'texto', '', 'Endpoint OTLP/HTTP del colector.', { ejemplo: 'http://otel-collector:4318' });
def('OTEL_EXPORTER_OTLP_HEADERS', 'texto', '', 'Cabeceras del exportador (clave=valor,clave=valor).', { secreta: true });
def('OTEL_SERVICE_NAME', 'texto', 'ipam', 'Nombre del servicio en las trazas.');
def('OTEL_TRACES_SAMPLER_ARG', 'texto', '1', 'Proporción de trazas que se muestrean (0 a 1).');

// Jira y webhook entrante
def(
  'JIRA_WEBHOOK_SECRET',
  'texto',
  '',
  'Clave HMAC del webhook entrante de Jira. En producción no tiene valor por defecto: sin ella el webhook queda deshabilitado.',
  { secreta: true },
);
def('JIRA_ENABLED', 'booleano', false, 'Activa la integración saliente con Jira.');
def('JIRA_BASE_URL', 'texto', '', 'URL de Jira Cloud.', { ejemplo: 'https://empresa.atlassian.net' });
def('JIRA_EMAIL', 'texto', '', 'Correo de la cuenta de servicio de Jira.');
def('JIRA_API_TOKEN', 'texto', '', 'Token de API de Jira.', { secreta: true });
def('JIRA_PROJECT', 'texto', '', 'Clave del proyecto de Jira.', { ejemplo: 'NET' });
def('JIRA_ISSUE_TYPE', 'texto', 'Task', 'Tipo de ticket que se crea.');
def('JIRA_DONE_TRANSITION', 'texto', 'Done', 'Transición final del ticket.');

// Marca
def('BRAND_NAME', 'texto', 'IPAM', 'Nombre en la barra y el título.');
def('BRAND_SUBTITLE', 'texto', '', 'Texto pequeño junto al nombre.');
def('BRAND_FOOTER', 'texto', '', 'Pie de página.');
def('BRAND_COLOR_TOP', 'texto', '#12203a', 'Color de la barra superior (#rrggbb).');
def('BRAND_COLOR', 'texto', '#2d6cdf', 'Color de botones (#rrggbb).');
def('BRAND_COLOR_ACCENT', 'texto', '#4da3ff', 'Color de acento (#rrggbb).');
def('BRAND_LOGO_FILE', 'texto', '', 'Ruta de un logo (png, jpg, webp o svg ≤ 512 KB).');

// ---------- Lectura ----------
const cacheArchivos = new Map(); // ruta → { firma, texto }
function leerArchivo(ruta) {
  try {
    const st = fs.statSync(ruta);
    const firma = `${st.mtimeMs}:${st.size}`;
    const c = cacheArchivos.get(ruta);
    if (c && c.firma === firma) return c.texto;
    const texto = fs.readFileSync(ruta, 'utf8').replace(/\r?\n$/, '');
    cacheArchivos.set(ruta, { firma, texto });
    return texto;
  } catch (e) {
    throw new ErrorDeConfiguracion([`No se pudo leer el archivo de secreto «${ruta}» (${e.code || 'error'}).`]);
  }
}

/** Valor crudo: variable directa o, si no existe, el contenido del archivo NOMBRE_FILE. */
function crudo(nombre) {
  const directo = process.env[nombre];
  if (directo !== undefined && directo !== '') return directo;
  const ruta = process.env[`${nombre}_FILE`];
  if (ruta) {
    const contenido = leerArchivo(ruta);
    return contenido === '' ? undefined : contenido; // un archivo vacío cuenta como «sin valor» (p. ej. un secreto opcional sin definir)
  }
  return undefined;
}

const VERDADEROS = new Set(['true', '1', 'yes', 'si', 'sí']);
const FALSOS = new Set(['false', '0', 'no', '']);

function valor(nombre) {
  const d = DEFINICIONES.get(nombre);
  if (!d) throw new Error(`Variable de configuración no declarada: ${nombre}`);
  const r = crudo(nombre);
  if (r === undefined) return d.defecto;
  const mostrar = d.secreta ? '«oculto»' : `«${String(r).slice(0, 60)}»`;
  switch (d.tipo) {
    case 'entero': {
      const n = Number(r);
      if (!Number.isInteger(n) || (d.min !== undefined && n < d.min) || (d.max !== undefined && n > d.max)) {
        throw new ErrorDeConfiguracion([`${nombre} debe ser un entero entre ${d.min} y ${d.max} (recibido ${mostrar}).`]);
      }
      return n;
    }
    case 'booleano': {
      const t = String(r).trim().toLowerCase();
      if (VERDADEROS.has(t)) return true;
      if (FALSOS.has(t)) return false;
      throw new ErrorDeConfiguracion([`${nombre} debe ser true o false (recibido ${mostrar}).`]);
    }
    case 'lista':
      return String(r)
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
    default: {
      const t = String(r);
      if (d.opciones && !d.opciones.includes(t)) {
        throw new ErrorDeConfiguracion([`${nombre} debe ser uno de: ${d.opciones.filter(Boolean).join(', ')} (recibido ${mostrar}).`]);
      }
      return t;
    }
  }
}

const IDENTIFICADOR = /^[a-z_][a-z0-9_]{0,62}$/;
const texto = (nombre) => valor(nombre);

const config = {
  get entorno() {
    return texto('NODE_ENV');
  },
  get produccion() {
    return texto('NODE_ENV') === 'production';
  },
  get rol() {
    return texto('ROL');
  },
  get log() {
    return { nivel: texto('LOG_LEVEL') };
  },
  get http() {
    const tp = texto('TRUST_PROXY').trim();
    const confiar = tp === '' || tp === 'false' ? undefined : Number.isNaN(Number(tp)) ? tp : Number(tp);
    return {
      puerto: valor('PORT'),
      trustProxy: confiar,
      jsonLimite: texto('JSON_LIMIT'),
      jsonLimiteImportar: texto('JSON_LIMIT_IMPORTAR'),
      hsts: valor('HSTS'),
      publicUrl: texto('PUBLIC_URL').replace(/\/+$/, ''),
      apagadoTimeoutMs: valor('APAGADO_TIMEOUT_MS'),
      solicitudTimeoutMs: valor('SOLICITUD_TIMEOUT_MS'),
    };
  },
  get bd() {
    return {
      url: texto('DATABASE_URL'),
      urlMigracion: texto('DATABASE_URL_MIGRACION') || texto('DATABASE_URL'),
      esquema: texto('DATABASE_SCHEMA'),
      ssl: texto('DATABASE_SSL'),
      sslCa: texto('DATABASE_SSL_CA'),
      poolMax: valor('DB_POOL_MAX'),
      conexionTimeoutMs: valor('DB_CONNECT_TIMEOUT_MS'),
      sentenciaTimeoutMs: valor('DB_STATEMENT_TIMEOUT_MS'),
      ociosoMs: valor('DB_IDLE_TIMEOUT_MS'),
      migrarAlArrancar: valor('MIGRAR_AL_ARRANCAR'),
    };
  },
  get auth() {
    const issuer = texto('OIDC_ISSUER');
    const user = texto('APP_USER'),
      pass = texto('APP_PASS');
    return {
      modo: issuer ? 'oidc' : user && pass ? 'basic' : 'none',
      permitirAnonimo: valor('ALLOW_ANONYMOUS'),
      appUser: user,
      appPass: pass,
      sesionSecreto: texto('SESSION_SECRET'),
      sesionHoras: valor('SESSION_HORAS'),
      cookieSecure: texto('COOKIE_SECURE'),
      tokenVidaDias: valor('TOKEN_VIDA_DIAS'),
      oidc: {
        issuer,
        clientId: texto('OIDC_CLIENT_ID'),
        clientSecret: texto('OIDC_CLIENT_SECRET'),
        scopes: texto('OIDC_SCOPES'),
        permitirInseguro: valor('OIDC_ALLOW_INSECURE'),
        dominios: valor('OIDC_ALLOWED_DOMAINS'),
        correosAdmin: valor('OIDC_ADMIN_EMAILS'),
        correosSolicitante: valor('OIDC_REQUESTER_EMAILS'),
        correosLector: valor('OIDC_READER_EMAILS'),
        claimGrupos: texto('OIDC_GROUPS_CLAIM'),
        gruposAdmin: valor('OIDC_ADMIN_GROUPS'),
        gruposSolicitante: valor('OIDC_REQUESTER_GROUPS'),
        gruposLector: valor('OIDC_READER_GROUPS'),
        rolPorDefecto: texto('OIDC_DEFAULT_ROLE').toLowerCase(),
      },
    };
  },
  get reservas() {
    return {
      ttlHoras: valor('RESERVA_TTL_HORAS'),
      ttlMaxHoras: valor('RESERVA_TTL_MAX_HORAS'),
      exigeAprobador: valor('CONFIRMACION_EXIGE_APROBADOR'),
      barredorIntervaloSeg: valor('BARREDOR_INTERVALO_SEGUNDOS'),
    };
  },
  get limite() {
    return {
      lecturaPorMinuto: valor('RATE_LIMIT_POR_MINUTO'),
      escrituraPorMinuto: valor('RATE_LIMIT_ESCRITURA_POR_MINUTO'),
      ipPorMinuto: valor('RATE_LIMIT_IP_POR_MINUTO'),
      authFallosPorMinuto: valor('RATE_LIMIT_AUTH_FALLOS_POR_MINUTO'),
      cuotaReservasPorToken: valor('CUOTA_RESERVAS_POR_TOKEN'),
      almacen: texto('LIMITE_ALMACEN'),
    };
  },
  get metricas() {
    return { token: texto('METRICS_TOKEN'), redesPermitidas: valor('METRICS_ALLOW_CIDRS') };
  },
  get eventos() {
    return {
      publicadores: valor('EVENTOS_PUBLICADORES'),
      webhook: {
        url: texto('EVENTOS_WEBHOOK_URL'),
        secreto: texto('EVENTOS_WEBHOOK_SECRET'),
        permitirHosts: valor('EVENTOS_WEBHOOK_PERMITIR_HOSTS'),
        timeoutMs: valor('EVENTOS_WEBHOOK_TIMEOUT_MS'),
        reintentos: valor('EVENTOS_WEBHOOK_REINTENTOS'),
      },
    };
  },
  get otel() {
    return {
      activo: texto('OTEL_TRACES_EXPORTER') === 'otlp',
      endpoint: texto('OTEL_EXPORTER_OTLP_ENDPOINT'),
      cabeceras: texto('OTEL_EXPORTER_OTLP_HEADERS'),
      servicio: texto('OTEL_SERVICE_NAME'),
      muestreo: Math.min(1, Math.max(0, Number(texto('OTEL_TRACES_SAMPLER_ARG')) || 0)),
    };
  },
  get webhookJira() {
    const s = texto('JIRA_WEBHOOK_SECRET');
    // Sin secreto: en desarrollo/pruebas se usa uno de juguete; en producción el webhook queda deshabilitado.
    return { secreto: s || (texto('NODE_ENV') === 'production' ? '' : 'dev-secret-cambiar') };
  },
  get jira() {
    return {
      activa: valor('JIRA_ENABLED'),
      baseUrl: texto('JIRA_BASE_URL'),
      email: texto('JIRA_EMAIL'),
      apiToken: texto('JIRA_API_TOKEN'),
      proyecto: texto('JIRA_PROJECT'),
      tipoTicket: texto('JIRA_ISSUE_TYPE'),
      transicionFinal: texto('JIRA_DONE_TRANSITION'),
    };
  },
  get marca() {
    return {
      nombre: texto('BRAND_NAME'),
      subtitulo: texto('BRAND_SUBTITLE'),
      pie: texto('BRAND_FOOTER'),
      colorBarra: texto('BRAND_COLOR_TOP'),
      color: texto('BRAND_COLOR'),
      colorAcento: texto('BRAND_COLOR_ACCENT'),
      logoArchivo: texto('BRAND_LOGO_FILE'),
    };
  },
};

/** Acumula errores y avisos; `intenta` lee un valor y, si es inválido, anota el problema en vez de lanzar. */
function crearContexto() {
  const errores = [];
  const avisos = [];
  const intenta = (fn) => {
    try {
      return fn();
    } catch (e) {
      (e.problemas || [e.message]).forEach((p) => errores.push(p));
      return undefined;
    }
  };
  return { errores, avisos, intenta };
}

// Las comprobaciones de BD no dependen de que el resto de los valores sean válidos: se leen una a una.
function validarBaseDeDatos({ errores, avisos, intenta }) {
  const url = intenta(() => valor('DATABASE_URL'));
  const esquema = intenta(() => valor('DATABASE_SCHEMA'));
  const ssl = intenta(() => valor('DATABASE_SSL'));
  if (url === '') errores.push('Falta DATABASE_URL (o DATABASE_URL_FILE).');
  if (esquema !== undefined && !IDENTIFICADOR.test(esquema))
    errores.push('DATABASE_SCHEMA debe ser un identificador simple en minúsculas (letras, números y _).');
  if (ssl === 'verify-full' && !intenta(() => valor('DATABASE_SSL_CA')))
    avisos.push('DATABASE_SSL=verify-full sin DATABASE_SSL_CA: se usarán las autoridades del sistema.');
  if (intenta(() => valor('MIGRAR_AL_ARRANCAR'))) avisos.push('MIGRAR_AL_ARRANCAR=true: la app aplicará el esquema al arrancar (excepción solo para el POC).');
}

function validarOidc({ errores, avisos }, a) {
  if (config.produccion && config.http.publicUrl && !config.http.publicUrl.startsWith('https://') && a.cookieSecure !== 'true') {
    avisos.push(
      'PUBLIC_URL no es https: la cookie de sesión no llevará el atributo Secure (a menos que la petición llegue por HTTPS con TRUST_PROXY). En producción usa https o COOKIE_SECURE=true.',
    );
  }
  const falta = [
    ['OIDC_CLIENT_ID', a.oidc.clientId],
    ['OIDC_CLIENT_SECRET', a.oidc.clientSecret],
    ['PUBLIC_URL', config.http.publicUrl],
    ['SESSION_SECRET', a.sesionSecreto],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (falta.length) errores.push(`Modo OIDC: faltan variables ${falta.join(', ')}.`);
  if (a.sesionSecreto && a.sesionSecreto.length < 32) errores.push('SESSION_SECRET debe tener al menos 32 caracteres.');
}

function validarAutenticacion(ctx) {
  const { errores, avisos, intenta } = ctx;
  const a = intenta(() => config.auth);
  if (!a) return;
  if (a.modo === 'oidc') validarOidc(ctx, a);
  if ((a.appUser && !a.appPass) || (!a.appUser && a.appPass)) errores.push('El modo Basic necesita APP_USER y APP_PASS juntos.');
  if (config.produccion && a.modo === 'none' && !a.permitirAnonimo) {
    errores.push('NODE_ENV=production sin autenticación: configura OIDC (OIDC_ISSUER…) o Basic (APP_USER y APP_PASS). Solo para demos: ALLOW_ANONYMOUS=true.');
  }
  if (a.modo === 'none' && a.permitirAnonimo) avisos.push('ALLOW_ANONYMOUS=true: cualquiera que llegue al servicio actúa como admin. Solo para demos.');
  if (a.modo === 'basic') avisos.push('Modo Basic: pensado para POC y demos. Para uso real configura OIDC. Guarda APP_PASS como hash scrypt.');
  if (a.modo === 'basic' && !String(a.appPass).startsWith('scrypt$')) avisos.push('APP_PASS está en texto plano: usa un hash (npm run hash-password).');
}

function validarReservasEventosYTrazas({ errores, intenta }) {
  const r = intenta(() => config.reservas);
  if (r && r.ttlHoras > r.ttlMaxHoras) errores.push('RESERVA_TTL_HORAS no puede superar RESERVA_TTL_MAX_HORAS.');
  const ev = intenta(() => config.eventos);
  if (ev && ev.publicadores.includes('webhook') && !(ev.webhook.url && ev.webhook.secreto))
    errores.push('El publicador «webhook» necesita EVENTOS_WEBHOOK_URL y EVENTOS_WEBHOOK_SECRET.');
  if (ev) for (const p of ev.publicadores) if (!['log', 'webhook'].includes(p)) errores.push(`EVENTOS_PUBLICADORES: adaptador desconocido «${p}».`);
  const o = intenta(() => config.otel);
  if (o && o.activo && !o.endpoint) errores.push('OTEL_TRACES_EXPORTER=otlp necesita OTEL_EXPORTER_OTLP_ENDPOINT.');
}

/** Devuelve { errores, avisos } sin lanzar. */
function validar() {
  const ctx = crearContexto();
  // Cada grupo se lee dentro de intenta(): reúne todos los errores de tipo/rango/opciones.
  for (const g of ['http', 'bd', 'auth', 'reservas', 'limite', 'metricas', 'eventos', 'otel', 'jira', 'marca', 'webhookJira']) ctx.intenta(() => config[g]);
  for (const n of DEFINICIONES.keys()) {
    if (process.env[n] && process.env[`${n}_FILE`]) ctx.avisos.push(`${n} y ${n}_FILE están definidas a la vez: se usa ${n}.`);
  }
  validarBaseDeDatos(ctx);
  validarAutenticacion(ctx);
  validarReservasEventosYTrazas(ctx);
  return { errores: [...new Set(ctx.errores)], avisos: [...new Set(ctx.avisos)] };
}

/** Validación mínima para `npm run migrar`: solo necesita la conexión del migrador, el esquema y el modo TLS (no la autenticación de la app). */
function validarParaMigrar() {
  const ctx = crearContexto();
  const url = ctx.intenta(() => valor('DATABASE_URL_MIGRACION') || valor('DATABASE_URL'));
  const esquema = ctx.intenta(() => valor('DATABASE_SCHEMA'));
  ctx.intenta(() => valor('DATABASE_SSL'));
  if (url === '') ctx.errores.push('Falta DATABASE_URL_MIGRACION (o DATABASE_URL): la conexión del usuario migrador.');
  if (esquema !== undefined && !IDENTIFICADOR.test(esquema))
    ctx.errores.push('DATABASE_SCHEMA debe ser un identificador simple en minúsculas (letras, números y _).');
  return { errores: [...new Set(ctx.errores)], avisos: [] };
}

/** Valida al arrancar: lanza un único error con todos los problemas. Devuelve los avisos. */
function validarOFallar() {
  const { errores, avisos } = validar();
  if (errores.length) throw new ErrorDeConfiguracion(errores);
  return avisos;
}

/** Catálogo para generar la documentación y comprobar que no queda nada sin documentar. */
const listarVariables = () => [...DEFINICIONES.values()];

module.exports = { config, validar, validarParaMigrar, validarOFallar, listarVariables, ErrorDeConfiguracion, IDENTIFICADOR };
