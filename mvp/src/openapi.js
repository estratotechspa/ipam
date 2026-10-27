'use strict';
// Contrato de la API del IPAM en OpenAPI 3.1 («contrato primero»).
//  - Es la FUENTE de verdad de los cuerpos de entrada: los esquemas de `components.schemas` se compilan con Ajv y validan cada petición.
//  - Una prueba comprueba que cada ruta registrada en Express exista aquí y al revés, que los ejemplos cumplan sus esquemas y que
//    las respuestas reales cumplan el contrato.
//  - Las rutas versionadas (/api/v1/…) son las principales. Cada una declara su alias histórico con `x-alias-legado` (/api/…), que sigue
//    funcionando igual para no romper a quien ya integró.
// Todos los rangos y nombres de los ejemplos son FICTICIOS.
const { version } = require('../package.json');

const UUID = '3f2b8c1e-7d4a-4c1b-9a55-0d2f6e8b1a10';
const AHORA = '2026-10-21T15:00:00.000Z';
const MANANA = '2026-10-22T15:00:00.000Z';

// ---------------------------------------------------------------- esquemas
const schemas = {
  Error: {
    type: 'object',
    required: ['error'],
    description:
      'Respuesta de error. `error` es un código estable (para programas); `mensaje` explica en español; `request_id` sirve para pedir ayuda: nunca incluye trazas ni detalles internos.',
    properties: { error: { type: 'string' }, mensaje: { type: 'string' }, request_id: { type: 'string' } },
    additionalProperties: true,
    example: { error: 'no_encontrado', mensaje: 'La reserva no existe.', request_id: '8d5a3f0c-2b1e-4f77-9c0a-5b6d7e8f9a01' },
  },
  ErrorValidacion: {
    allOf: [
      { $ref: '#/components/schemas/Error' },
      {
        type: 'object',
        properties: { detalles: { type: 'array', items: { type: 'object', properties: { campo: { type: 'string' }, mensaje: { type: 'string' } } } } },
      },
    ],
    example: {
      error: 'validacion',
      mensaje: 'El cuerpo no cumple el contrato.',
      detalles: [{ campo: '/vpc', mensaje: 'debe ser texto' }],
      request_id: '8d5a3f0c-2b1e-4f77-9c0a-5b6d7e8f9a01',
    },
  },
  ErrorSolapamiento: {
    allOf: [
      { $ref: '#/components/schemas/Error' },
      {
        type: 'object',
        properties: {
          conflicto: {
            type: 'object',
            description: 'El rango que ya está ocupado (asignado o reservado).',
            properties: {
              fuente: { enum: ['asignacion', 'reserva'] },
              cidr: { $ref: '#/components/schemas/Cidr' },
              vpc: { type: 'string' },
              solicitante: { type: 'string' },
              ticket: { type: 'string' },
              creado_en: { type: 'string', format: 'date-time' },
              expira_en: { type: 'string', format: 'date-time' },
            },
          },
          sugeridos: { type: 'array', description: 'Rangos libres del mismo tamaño.', items: { $ref: '#/components/schemas/Cidr' } },
        },
      },
    ],
    example: {
      error: 'solapamiento',
      mensaje: '10.220.0.0/24 se solapa con un rango ya reservado.',
      conflicto: {
        fuente: 'reserva',
        cidr: '10.220.0.0/24',
        vpc: 'proyecto-demo-qa',
        solicitante: 'svc:agente-redes',
        ticket: 'NET-901',
        creado_en: AHORA,
        expira_en: MANANA,
      },
      sugeridos: ['10.220.1.0/24', '10.220.2.0/24', '10.220.3.0/24'],
      request_id: '8d5a3f0c-2b1e-4f77-9c0a-5b6d7e8f9a01',
    },
  },
  ErrorAmbiguo: {
    allOf: [
      { $ref: '#/components/schemas/Error' },
      {
        type: 'object',
        properties: {
          opciones: {
            type: 'array',
            description: 'Pools candidatos: repite la petición indicando `pool`.',
            items: {
              type: 'object',
              properties: {
                pool: { type: 'string' },
                cidr: { $ref: '#/components/schemas/Cidr' },
                tipo: { type: 'string' },
                ambiente: { $ref: '#/components/schemas/Ambiente' },
                proveedor: { type: 'string' },
              },
            },
          },
        },
      },
    ],
    example: {
      error: 'ambiguo',
      mensaje: 'Hay 2 pools de tipo Pods en qa: indica cuál con «pool».',
      opciones: [
        { pool: 'qa-pods-a', cidr: '10.221.0.0/16', tipo: 'Pods', ambiente: 'qa', proveedor: 'GCP' },
        { pool: 'qa-pods-b', cidr: '10.222.0.0/16', tipo: 'Pods', ambiente: 'qa', proveedor: 'GCP' },
      ],
      request_id: '8d5a3f0c-2b1e-4f77-9c0a-5b6d7e8f9a01',
    },
  },
  ErrorCuota: {
    allOf: [{ $ref: '#/components/schemas/Error' }, { type: 'object', properties: { vigentes: { type: 'integer' }, limite: { type: 'integer' } } }],
    example: {
      error: 'cuota_excedida',
      mensaje: 'Tienes 20 reservas vigentes de 20 permitidas. Confirma o libera alguna antes de pedir otra.',
      vigentes: 20,
      limite: 20,
      request_id: '8d5a3f0c-2b1e-4f77-9c0a-5b6d7e8f9a01',
    },
  },
  ErrorRateLimit: {
    allOf: [
      { $ref: '#/components/schemas/Error' },
      {
        type: 'object',
        properties: { retry_after: { type: 'integer', description: 'Segundos que conviene esperar.' }, limite_por_minuto: { type: 'integer' } },
      },
    ],
    example: {
      error: 'rate_limit',
      mensaje: 'Demasiadas peticiones. Reintenta en 12 segundos.',
      retry_after: 12,
      limite_por_minuto: 120,
      request_id: '8d5a3f0c-2b1e-4f77-9c0a-5b6d7e8f9a01',
    },
  },
  Cidr: { type: 'string', pattern: '^\\d{1,3}(\\.\\d{1,3}){3}/\\d{1,2}$', description: 'Rango IPv4 en notación CIDR.', example: '10.220.0.0/24' },
  Ambiente: { enum: ['dev', 'qa', 'pre', 'prod'], description: 'Ambiente.' },
  Salud: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } }, example: { ok: true } },
  Listo: {
    type: 'object',
    required: ['ok'],
    properties: {
      ok: { type: 'boolean' },
      motivo: { enum: ['bd_inalcanzable', 'esquema_desactualizado', 'apagando'] },
      esquema: { type: 'object', properties: { version: { type: 'integer' }, minima: { type: 'integer' } } },
    },
    example: { ok: true, esquema: { version: 4, minima: 4 } },
  },
  Me: {
    type: 'object',
    required: ['modo', 'usuario', 'rol'],
    properties: {
      modo: { enum: ['oidc', 'basic', 'token', 'none'] },
      usuario: { type: 'string' },
      nombre: { type: 'string' },
      rol: { enum: ['lector', 'agente', 'solicitante', 'admin'] },
      local: { type: 'boolean', description: 'Cuenta local con contraseña (AUTH_LOCAL).' },
      debe_cambiar_clave: { type: 'boolean', description: 'La contraseña es temporal: hay que cambiarla antes de seguir.' },
      cuentas_locales: { type: 'boolean', description: 'El servicio admite cuentas locales.' },
    },
    example: { modo: 'token', usuario: 'svc:agente-redes', nombre: 'svc:agente-redes', rol: 'agente' },
  },
  Marca: {
    type: 'object',
    properties: { nombre: { type: 'string' }, subtitulo: { type: 'string' }, pie: { type: 'string' }, logo: { type: ['string', 'null'] } },
    example: { nombre: 'IPAM', subtitulo: '', pie: '', logo: null },
  },
  Pool: {
    type: 'object',
    required: ['id', 'tipo', 'ambiente', 'proveedor', 'cidr', 'asignaciones', 'uso', 'reservas_vigentes'],
    properties: {
      id: { type: 'string' },
      tipo: { type: 'string', description: 'Nodos, Pods, Servicios, Control plane…' },
      ambiente: { $ref: '#/components/schemas/Ambiente' },
      proveedor: { type: 'string' },
      cidr: { $ref: '#/components/schemas/Cidr' },
      asignaciones: { type: 'integer', description: 'Cantidad de rangos asignados (definitivos).' },
      uso: { type: 'number', minimum: 0, maximum: 1, description: 'Fracción del pool ya asignada (0 a 1).' },
      reservas_vigentes: { type: 'integer', description: 'Reservas tentativas que siguen vigentes.' },
      uso_reservado: { type: 'number', minimum: 0, maximum: 1, description: 'Fracción del pool apartada por reservas vigentes.' },
    },
    example: {
      id: 'gke-nodos-qa',
      tipo: 'Nodos',
      ambiente: 'qa',
      proveedor: 'GCP',
      cidr: '10.220.0.0/16',
      asignaciones: 3,
      uso: 0.0117,
      reservas_vigentes: 1,
      uso_reservado: 0.0039,
    },
  },
  Direccion: {
    type: 'object',
    required: ['id', 'ip', 'rol', 'creado_por', 'creado_en'],
    properties: {
      id: { type: 'string', pattern: '^\\d+$' },
      ip: { type: 'string', format: 'ipv4' },
      pool_id: { type: ['string', 'null'], description: 'Pool que la contiene (null si es una excepción fuera de todo pool).' },
      asignacion_id: { type: ['string', 'null'], description: 'Segmento que la contiene (null si es una excepción).' },
      dispositivo: { type: ['string', 'null'], description: 'Equipo: rtr-core-01, sw-acceso-3, fw-borde…' },
      interfaz: { type: ['string', 'null'], description: 'Interfaz del equipo: Gi0/1, xe-0/0/1.100, ethernet1/1…' },
      rol: { $ref: '#/components/schemas/RolDireccion' },
      dns: { type: ['string', 'null'] },
      descripcion: { type: ['string', 'null'] },
      excepcion: { type: ['string', 'null'], description: 'Motivo, solo si la IP está fuera de un segmento asignado.' },
      creado_por: { type: 'string' },
      creado_en: { type: 'string', format: 'date-time' },
      segmento: { type: ['string', 'null'], description: 'CIDR del segmento (en listados y al crear).' },
      segmento_codigo: { type: ['string', 'null'], description: 'ID legible del segmento (ASG-000123).' },
      aviso: { type: ['string', 'null'], description: 'Solo al crear: p. ej. si es la dirección de red o de difusión del segmento.' },
    },
    example: {
      id: '7',
      ip: '10.220.16.1',
      pool_id: 'gke-nodos-qa',
      asignacion_id: '13',
      dispositivo: 'rtr-core-01',
      interfaz: 'Gi0/1',
      rol: 'gateway',
      dns: 'gw-qa.ejemplo.internal',
      descripcion: 'Gateway del segmento de nodos',
      excepcion: null,
      creado_por: 'ana',
      creado_en: AHORA,
    },
  },
  RolDireccion: { enum: ['interfaz', 'gateway', 'gestion', 'loopback', 'vip', 'servidor', 'otro'], description: 'Para qué se usa la IP.' },
  DireccionCrear: {
    type: 'object',
    required: ['ip'],
    additionalProperties: false,
    description:
      'El IPAM ubica la IP en su segmento asignado. Si está fuera de todo segmento, es una **excepción** y `excepcion` (el motivo) es obligatorio. Si la IP existe en varios pools (rangos privados repetidos), responde 422 con `opciones`: repite indicando `pool`.',
    properties: {
      ip: { type: 'string', description: 'IPv4 (10.20.0.1 o 10.20.0.1/32).' },
      pool: { type: 'string', description: 'Solo si la IP cae en varios pools.' },
      dispositivo: { type: 'string', maxLength: 80 },
      interfaz: { type: 'string', maxLength: 80 },
      rol: { $ref: '#/components/schemas/RolDireccion' },
      dns: { type: 'string', maxLength: 253 },
      descripcion: { type: 'string', maxLength: 200 },
      excepcion: { type: 'string', maxLength: 200, description: 'Motivo, obligatorio si la IP no está dentro de un segmento asignado.' },
    },
    example: { ip: '10.220.16.1', dispositivo: 'rtr-core-01', interfaz: 'Gi0/1', rol: 'gateway', descripcion: 'Gateway del segmento de nodos' },
  },
  DireccionEditar: {
    type: 'object',
    additionalProperties: false,
    description: 'Lo que no venga se conserva. La IP no se cambia: elimina la dirección y registra otra.',
    properties: {
      dispositivo: { type: ['string', 'null'], maxLength: 80 },
      interfaz: { type: ['string', 'null'], maxLength: 80 },
      rol: { $ref: '#/components/schemas/RolDireccion' },
      dns: { type: ['string', 'null'], maxLength: 253 },
      descripcion: { type: ['string', 'null'], maxLength: 200 },
      excepcion: { type: ['string', 'null'], maxLength: 200 },
    },
    example: { interfaz: 'Gi0/2', descripcion: 'Movido a la interfaz 2' },
  },
  PoolCrear: {
    type: 'object',
    required: ['id', 'tipo', 'ambiente', 'proveedor', 'cidr'],
    additionalProperties: false,
    description: 'Bloque base nuevo. No puede solaparse con otro pool del MISMO proveedor y ambiente (entre ambientes o proveedores distintos sí).',
    properties: {
      id: { type: 'string', maxLength: 63, description: 'Nombre: minúsculas, números y guiones (p. ej. lan-sucursal-prod).' },
      tipo: { type: 'string', maxLength: 40, description: 'Nodos, Pods, Servicios, LAN, Gestión…' },
      ambiente: { $ref: '#/components/schemas/Ambiente' },
      proveedor: { type: 'string', maxLength: 40, description: 'GCP, On-prem, AWS…' },
      cidr: { $ref: '#/components/schemas/Cidr' },
    },
    example: { id: 'lan-sucursal-prod', tipo: 'LAN', ambiente: 'prod', proveedor: 'On-prem', cidr: '10.40.0.0/16' },
  },
  PoolEditar: {
    type: 'object',
    required: ['tipo', 'proveedor'],
    additionalProperties: false,
    description: 'Solo se editan tipo y proveedor: cambiar el CIDR o el ambiente dejaría segmentos fuera de su pool.',
    properties: { tipo: { type: 'string', maxLength: 40 }, proveedor: { type: 'string', maxLength: 40 } },
    example: { tipo: 'LAN', proveedor: 'On-prem' },
  },
  Resumen: {
    type: 'object',
    required: ['pools', 'asignaciones', 'uso_promedio', 'solapamientos'],
    properties: {
      pools: { type: 'integer' },
      asignaciones: { type: 'integer' },
      uso_promedio: { type: 'number' },
      solapamientos: { type: 'integer', description: 'Siempre 0: la base de datos impide los solapes.' },
    },
    example: { pools: 6, asignaciones: 12, uso_promedio: 0.05, solapamientos: 0 },
  },
  Asignacion: {
    type: 'object',
    required: ['id', 'pool_id', 'cidr', 'vpc', 'solicitante', 'ticket', 'origen'],
    properties: {
      id: { type: 'string', pattern: '^\\d+$', description: 'Identificador numérico (como texto).' },
      codigo: {
        type: 'string',
        pattern: '^ASG-\\d{6,}$',
        description:
          'ID legible de la asignación (ASG-000123). Identifica la asignación, no el rango: el mismo CIDR puede asignarse otra vez más adelante con otro ID.',
      },
      pool_id: { type: 'string' },
      ambiente: { $ref: '#/components/schemas/Ambiente', description: 'Ambiente del pool (solo en la lista paginada).' },
      cidr: { $ref: '#/components/schemas/Cidr' },
      vpc: { type: 'string' },
      vlan: { type: ['integer', 'null'], minimum: 1, maximum: 4094, description: 'VLAN (opcional).' },
      vlan_nombre: { type: ['string', 'null'], maxLength: 80, description: 'Nombre de la VLAN o subred (opcional).' },
      solicitante: { type: 'string' },
      ticket: { type: 'string' },
      origen: { enum: ['panel', 'jira', 'semilla', 'agente', 'importado'] },
      creado_en: { type: 'string', format: 'date-time' },
    },
    example: {
      id: '13',
      pool_id: 'gke-nodos-qa',
      cidr: '10.220.16.0/24',
      vpc: 'proyecto-demo-qa',
      solicitante: 'svc:agente-redes',
      ticket: 'NET-901',
      origen: 'agente',
      creado_en: AHORA,
    },
  },
  Solicitud: {
    type: 'object',
    required: ['pool', 'vpc'],
    description:
      'Asignación directa (sin reserva previa ni aprobación de otra persona), solo para admin. El flujo normal es reservar (`POST /reservas`) y que un admin apruebe.',
    properties: {
      pool: { type: 'string' },
      vpc: { type: 'string' },
      cidr: { $ref: '#/components/schemas/Cidr' },
      mascara: { type: 'integer' },
      vlan: { type: ['integer', 'string', 'null'], description: 'VLAN opcional (1–4094).' },
      vlan_nombre: { type: ['string', 'null'], maxLength: 80, description: 'Nombre opcional de la VLAN o subred.' },
    },
    example: { pool: 'gke-nodos-qa', vpc: 'proyecto-demo-qa', mascara: 24, vlan: 210, vlan_nombre: 'qa-nodos' },
  },
  Liberacion: {
    type: 'object',
    required: ['liberado'],
    properties: {
      liberado: { type: 'object', properties: { cidr: { $ref: '#/components/schemas/Cidr' }, ticket: { type: 'string' }, pool_id: { type: 'string' } } },
    },
    example: { liberado: { cidr: '10.220.16.0/24', ticket: 'NET-901', pool_id: 'gke-nodos-qa' } },
  },
  ReservaCrear: {
    type: 'object',
    required: ['vpc'],
    additionalProperties: false,
    description:
      'Indica el destino con `pool`, o con `ambiente` + `tipo` (si hay más de un pool candidato, la respuesta es 422 con `opciones`), y el tamaño con `mascara` o con `cidr`.',
    properties: {
      pool: { type: 'string', maxLength: 100 },
      ambiente: { $ref: '#/components/schemas/Ambiente' },
      tipo: { type: 'string', maxLength: 40, description: 'Tipo de pool: Nodos, Pods, Servicios, Control plane…' },
      mascara: { type: 'integer', description: 'Tamaño del bloque (24 = /24), de 8 a 32. Se busca el primer rango libre.' },
      cidr: { $ref: '#/components/schemas/Cidr' },
      vpc: { type: 'string', maxLength: 120, description: 'Proyecto / VPC al que se destina.' },
      ticket: { type: 'string', maxLength: 64, description: 'Referencia de seguimiento. Si falta, el IPAM genera una (NET-n).' },
      vlan: { type: ['integer', 'string', 'null'], description: 'VLAN opcional (1–4094); pasa a la asignación al confirmar.' },
      vlan_nombre: { type: ['string', 'null'], maxLength: 80, description: 'Nombre opcional de la VLAN o subred.' },
      ttl_horas: { type: 'integer', description: 'Vigencia de la reserva sin confirmar. Por defecto 24; máximo 72 (RESERVA_TTL_MAX_HORAS).' },
    },
    example: { ambiente: 'qa', tipo: 'Nodos', mascara: 24, vpc: 'proyecto-demo-qa', ticket: 'NET-901', ttl_horas: 24 },
  },
  Reserva: {
    type: 'object',
    required: ['id', 'pool_id', 'cidr', 'vpc', 'solicitante', 'ticket', 'estado', 'creado_en', 'expira_en'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      pool_id: { type: 'string' },
      cidr: { $ref: '#/components/schemas/Cidr' },
      vpc: { type: 'string' },
      vlan: { type: ['integer', 'null'], minimum: 1, maximum: 4094, description: 'VLAN (opcional).' },
      vlan_nombre: { type: ['string', 'null'], maxLength: 80, description: 'Nombre de la VLAN o subred (opcional).' },
      solicitante: { type: 'string' },
      ticket: { type: 'string' },
      estado: { enum: ['reservada', 'confirmada', 'liberada', 'expirada'], description: 'Estado real ahora: una reservada vencida ya figura como expirada.' },
      creado_en: { type: 'string', format: 'date-time' },
      expira_en: { type: 'string', format: 'date-time' },
      resuelto_en: { type: ['string', 'null'], format: 'date-time' },
      asignacion_id: { type: ['string', 'null'], description: 'Asignación definitiva (solo si está confirmada).' },
      segundos_restantes: { type: 'integer', description: 'Segundos que le quedan a una reserva vigente (0 si ya no lo está).' },
    },
    example: {
      id: UUID,
      pool_id: 'gke-nodos-qa',
      cidr: '10.220.16.0/24',
      vpc: 'proyecto-demo-qa',
      solicitante: 'svc:agente-redes',
      ticket: 'NET-901',
      estado: 'reservada',
      creado_en: AHORA,
      expira_en: MANANA,
      resuelto_en: null,
      asignacion_id: null,
      segundos_restantes: 86400,
    },
  },
  ReservaRespuesta: {
    allOf: [
      { $ref: '#/components/schemas/Reserva' },
      {
        type: 'object',
        required: ['repetida'],
        properties: { repetida: { type: 'boolean', description: 'true si es la respuesta de una petición idempotente repetida.' } },
      },
    ],
    example: {
      id: UUID,
      pool_id: 'gke-nodos-qa',
      cidr: '10.220.16.0/24',
      vpc: 'proyecto-demo-qa',
      solicitante: 'svc:agente-redes',
      ticket: 'NET-901',
      estado: 'reservada',
      creado_en: AHORA,
      expira_en: MANANA,
      resuelto_en: null,
      asignacion_id: null,
      segundos_restantes: 86400,
      repetida: false,
    },
  },
  ReservaConfirmar: {
    type: 'object',
    additionalProperties: false,
    description: 'Un agente (token) DEBE indicar la aprobación humana. Una persona que confirma desde la interfaz no necesita declararla.',
    properties: {
      aprobado_por: { type: 'string', maxLength: 200, description: 'Quién aprobó el cambio.' },
      referencia: { type: 'string', maxLength: 300, description: 'Dónde consta la aprobación (p. ej. la URL del merge request aprobado).' },
    },
    example: { aprobado_por: 'ana@empresa.example', referencia: 'https://gitlab.example/redes/-/merge_requests/12' },
  },
  ReservaConfirmada: {
    allOf: [
      { $ref: '#/components/schemas/Reserva' },
      {
        type: 'object',
        required: ['repetida', 'asignacion'],
        properties: { repetida: { type: 'boolean' }, asignacion: { $ref: '#/components/schemas/Asignacion' } },
      },
    ],
    example: {
      id: UUID,
      pool_id: 'gke-nodos-qa',
      cidr: '10.220.16.0/24',
      vpc: 'proyecto-demo-qa',
      solicitante: 'svc:agente-redes',
      ticket: 'NET-901',
      estado: 'confirmada',
      creado_en: AHORA,
      expira_en: MANANA,
      resuelto_en: AHORA,
      asignacion_id: '13',
      segundos_restantes: 0,
      repetida: false,
      asignacion: {
        id: '13',
        pool_id: 'gke-nodos-qa',
        cidr: '10.220.16.0/24',
        vpc: 'proyecto-demo-qa',
        solicitante: 'svc:agente-redes',
        ticket: 'NET-901',
        origen: 'agente',
        creado_en: AHORA,
      },
    },
  },
  ReservaLiberada: {
    allOf: [
      { $ref: '#/components/schemas/Reserva' },
      {
        type: 'object',
        required: ['repetida', 'asignacion_borrada'],
        properties: {
          repetida: { type: 'boolean' },
          asignacion_borrada: { type: 'boolean', description: 'true si estaba confirmada y se borró su asignación definitiva.' },
        },
      },
    ],
    example: {
      id: UUID,
      pool_id: 'gke-nodos-qa',
      cidr: '10.220.16.0/24',
      vpc: 'proyecto-demo-qa',
      solicitante: 'svc:agente-redes',
      ticket: 'NET-901',
      estado: 'liberada',
      creado_en: AHORA,
      expira_en: MANANA,
      resuelto_en: AHORA,
      asignacion_id: null,
      segundos_restantes: 0,
      repetida: false,
      asignacion_borrada: false,
    },
  },
  TokenCrear: {
    type: 'object',
    required: ['nombre', 'rol'],
    additionalProperties: false,
    properties: {
      nombre: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,40}$', description: 'Único. Para rotar, crea uno nuevo con otro nombre y revoca el anterior.' },
      rol: { enum: ['lector', 'agente'] },
      expira_dias: { type: 'integer', description: 'Vigencia de 1 a 365 días (90 por defecto).' },
      cuota_reservas: {
        type: 'integer',
        description: 'Máximo de reservas vigentes simultáneas de este token (por defecto, el general CUOTA_RESERVAS_POR_TOKEN).',
      },
    },
    example: { nombre: 'agente-redes', rol: 'agente', expira_dias: 90, cuota_reservas: 20 },
  },
  Token: {
    type: 'object',
    required: ['id', 'nombre', 'prefijo', 'rol', 'expira_en', 'estado'],
    description: 'Datos de un token. Nunca incluye el token ni su hash.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      nombre: { type: 'string' },
      prefijo: { type: 'string', description: 'Primeros caracteres: reconoce el token en una lista.' },
      rol: { enum: ['lector', 'agente'] },
      cuota_reservas: { type: ['integer', 'null'] },
      creado_por: { type: 'string' },
      creado_en: { type: 'string', format: 'date-time' },
      expira_en: { type: 'string', format: 'date-time' },
      ultimo_uso: { type: ['string', 'null'], format: 'date-time' },
      revocado_en: { type: ['string', 'null'], format: 'date-time' },
      estado: { enum: ['activo', 'vencido', 'revocado'] },
      por_vencer: { type: 'boolean', description: 'true si vence en menos de 7 días.' },
    },
    example: {
      id: UUID,
      nombre: 'agente-redes',
      prefijo: 'ipam_AbCd',
      rol: 'agente',
      cuota_reservas: 20,
      creado_por: 'jefe@empresa.example',
      creado_en: AHORA,
      expira_en: '2027-01-19T15:00:00.000Z',
      ultimo_uso: null,
      revocado_en: null,
      estado: 'activo',
      por_vencer: false,
    },
  },
  TokenCreado: {
    allOf: [
      { $ref: '#/components/schemas/Token' },
      {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string', pattern: '^ipam_[A-Za-z0-9_-]{43}$', description: 'EL TOKEN. Se muestra una sola vez: guárdalo en tu gestor de secretos.' },
        },
      },
    ],
    example: {
      id: UUID,
      nombre: 'agente-redes',
      prefijo: 'ipam_AbCd',
      rol: 'agente',
      cuota_reservas: 20,
      creado_por: 'jefe@empresa.example',
      creado_en: AHORA,
      expira_en: '2027-01-19T15:00:00.000Z',
      ultimo_uso: null,
      revocado_en: null,
      estado: 'activo',
      por_vencer: false,
      token: 'ipam_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_ABCDE',
    },
  },
  Usuario: {
    type: 'object',
    required: ['email'],
    properties: {
      email: { type: 'string' },
      nombre: { type: 'string' },
      rol: { enum: ['lector', 'solicitante', 'admin', null] },
      activo: { type: 'boolean', description: 'false = dado de baja: no puede entrar.' },
      local: { type: 'boolean', description: 'true = cuenta local con contraseña; false = cuenta SSO.' },
      debe_cambiar_clave: { type: 'boolean' },
      ultimo_acceso: { type: ['string', 'null'], format: 'date-time' },
      creado_en: { type: 'string', format: 'date-time' },
      creado_por: { type: ['string', 'null'] },
    },
    example: { email: 'ana@empresa.example', nombre: 'Ana', rol: 'solicitante', activo: true, local: false, debe_cambiar_clave: false, ultimo_acceso: AHORA },
  },
  ImportacionSolicitud: {
    type: 'object',
    required: ['formato', 'contenido_base64'],
    properties: {
      nombre: { type: 'string', description: 'Nombre del archivo (solo para la auditoría).' },
      formato: { enum: ['xlsx', 'csv'] },
      contenido_base64: { type: 'string', description: 'El archivo codificado en base64.' },
      proveedor: { type: 'string', description: 'Proveedor por defecto para las filas que no lo traen (p. ej. GCP u On-prem).' },
      ambiente: { enum: ['dev', 'qa', 'pre', 'prod'], description: 'Ambiente por defecto para las filas que no lo traen.' },
      tipo: { type: 'string', description: 'Tipo por defecto (por omisión «Importado»).' },
      aprobar: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Solo en «aplicar»: números de fila (como se ven en el archivo) que se solapan con OTRO pool y un admin decidió aceptar.',
      },
    },
    example: { nombre: 'segmentos.xlsx', formato: 'xlsx', contenido_base64: 'UEsDBBQ…', proveedor: 'GCP', ambiente: 'prod' },
  },
  UsuarioCrear: {
    type: 'object',
    required: ['email', 'rol'],
    properties: {
      email: { type: 'string', description: 'Correo (SSO) o nombre de usuario (cuenta local), en minúsculas.' },
      nombre: { type: 'string' },
      rol: { enum: ['lector', 'solicitante', 'admin'] },
      local: { type: 'boolean', description: 'true = cuenta local con clave temporal (requiere AUTH_LOCAL); false o ausente = pre-registro SSO.' },
    },
    example: { email: 'ana@empresa.example', nombre: 'Ana', rol: 'solicitante', local: false },
  },
  CambioClave: {
    type: 'object',
    required: ['actual', 'nueva'],
    properties: { actual: { type: 'string' }, nueva: { type: 'string', minLength: 12, description: 'Al menos 12 caracteres y distinta de la actual.' } },
  },
  UsuarioRol: {
    type: 'object',
    required: ['rol'],
    properties: { rol: { enum: ['lector', 'solicitante', 'admin', null], description: 'null = heredar de los grupos del proveedor.' } },
    example: { rol: 'solicitante' },
  },
  AuditoriaFila: {
    type: 'object',
    required: ['id', 'ts', 'usuario', 'accion'],
    properties: {
      id: { type: 'string' },
      ts: { type: 'string', format: 'date-time' },
      usuario: { type: 'string' },
      rol: { type: ['string', 'null'] },
      accion: { type: 'string' },
      detalle: { type: 'object' },
      ip: { type: ['string', 'null'] },
      request_id: { type: ['string', 'null'] },
    },
    example: {
      id: '41',
      ts: AHORA,
      usuario: 'svc:agente-redes',
      rol: 'agente',
      accion: 'reservar',
      detalle: { reserva: UUID, cidr: '10.220.16.0/24' },
      ip: '10.0.0.5',
      request_id: '8d5a3f0c-2b1e-4f77-9c0a-5b6d7e8f9a01',
    },
  },
  Evento: {
    type: 'object',
    required: ['id', 'ts', 'tipo'],
    properties: { id: { type: 'string' }, ts: { type: 'string', format: 'date-time' }, tipo: { type: 'string' }, detalle: { type: 'object' } },
    example: { id: '7', ts: AHORA, tipo: 'reserva_creada', detalle: { reserva: UUID, cidr: '10.220.16.0/24' } },
  },
  JiraEstado: {
    type: 'object',
    required: ['activa', 'faltantes'],
    properties: {
      activa: { type: 'boolean' },
      faltantes: { type: 'array', items: { type: 'string' } },
      simulador: { type: 'boolean', description: 'POST /api/v1/jira/simular está disponible (fuera de producción, o con ENABLE_SIMULADOR=true).' },
    },
    example: { activa: false, faltantes: [], simulador: true },
  },
  JiraTicket: {
    type: 'object',
    required: ['ticket', 'ambiente', 'tipo', 'mascara', 'vpc'],
    description:
      'Cuerpo del webhook de Jira. Va firmado con la hora: `x-ipam-timestamp` y `x-hub-signature-256: sha256=HMAC(JIRA_WEBHOOK_SECRET, "<timestamp>.<cuerpo>")`.',
    properties: {
      ticket: { type: 'string' },
      ambiente: { $ref: '#/components/schemas/Ambiente' },
      tipo: { type: 'string' },
      mascara: { type: 'integer' },
      vpc: { type: 'string' },
    },
    example: { ticket: 'NET-9001', ambiente: 'qa', tipo: 'Nodos', mascara: 24, vpc: 'proyecto-demo-qa' },
  },
  JiraSimular: {
    type: 'object',
    required: ['ambiente', 'tipo', 'mascara', 'vpc'],
    properties: { ambiente: { $ref: '#/components/schemas/Ambiente' }, tipo: { type: 'string' }, mascara: { type: 'integer' }, vpc: { type: 'string' } },
    example: { ambiente: 'qa', tipo: 'Nodos', mascara: 24, vpc: 'proyecto-demo-qa' },
  },
  JiraResultado: {
    type: 'object',
    required: ['ticket', 'cidr'],
    description: 'El ticket NO asigna: crea una reserva tentativa que un admin debe aprobar (confirmar) para volverse asignación.',
    properties: {
      ticket: { type: 'string' },
      pool: { type: 'string' },
      cidr: { $ref: '#/components/schemas/Cidr' },
      estado: { type: 'string', enum: ['pendiente_de_aprobacion'] },
      reserva: { type: 'string', format: 'uuid', description: 'Id de la reserva a aprobar en la pestaña Reservas.' },
      expira_en: { type: 'string', format: 'date-time' },
    },
    example: {
      ticket: 'NET-9001',
      pool: 'gke-nodos-qa',
      cidr: '10.220.32.0/24',
      estado: 'pendiente_de_aprobacion',
      reserva: '5f0c2a1e-8c52-4d0e-9f6b-2f2a7c1d9a10',
      expira_en: '2026-10-23T14:00:00.000Z',
    },
  },
  Respaldo: {
    type: 'object',
    required: ['formato', 'version', 'pools', 'asignaciones'],
    description: 'Respaldo lógico (pools, asignaciones y roles asignados). No incluye reservas, que son transitorias.',
    properties: {
      formato: { const: 'ipam-respaldo' },
      version: { const: 1 },
      generado: { type: 'string', format: 'date-time' },
      pools: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'tipo', 'ambiente', 'proveedor', 'cidr'],
          properties: {
            id: { type: 'string' },
            tipo: { type: 'string' },
            ambiente: { $ref: '#/components/schemas/Ambiente' },
            proveedor: { type: 'string' },
            cidr: { $ref: '#/components/schemas/Cidr' },
          },
        },
      },
      asignaciones: {
        type: 'array',
        items: {
          type: 'object',
          required: ['pool_id', 'cidr', 'vpc', 'ticket'],
          properties: {
            pool_id: { type: 'string' },
            cidr: { $ref: '#/components/schemas/Cidr' },
            vpc: { type: 'string' },
            vlan: { type: ['integer', 'null'] },
            vlan_nombre: { type: ['string', 'null'] },
            solicitante: { type: 'string' },
            ticket: { type: 'string' },
            origen: { type: 'string' },
            creado_en: { type: 'string', format: 'date-time' },
          },
        },
      },
      usuarios: { type: 'array', items: { type: 'object', properties: { email: { type: 'string' }, nombre: { type: 'string' }, rol: { type: 'string' } } } },
      direcciones: {
        type: 'array',
        description: 'IPs fijas. Se enlazan con su segmento por `pool_id` + `segmento` (CIDR); sin segmento quedan como excepción.',
        items: {
          type: 'object',
          required: ['ip'],
          properties: {
            ip: { type: 'string' },
            pool_id: { type: ['string', 'null'] },
            segmento: { type: ['string', 'null'] },
            dispositivo: { type: ['string', 'null'] },
            interfaz: { type: ['string', 'null'] },
            rol: { type: 'string' },
            dns: { type: ['string', 'null'] },
            descripcion: { type: ['string', 'null'] },
            excepcion: { type: ['string', 'null'] },
            creado_por: { type: 'string' },
            creado_en: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    example: {
      formato: 'ipam-respaldo',
      version: 1,
      generado: AHORA,
      pools: [{ id: 'gke-nodos-qa', tipo: 'Nodos', ambiente: 'qa', proveedor: 'GCP', cidr: '10.220.0.0/16' }],
      asignaciones: [
        { pool_id: 'gke-nodos-qa', cidr: '10.220.0.0/20', vpc: 'proyecto-demo-qa', solicitante: 'ana', ticket: 'NET-110', origen: 'panel', creado_en: AHORA },
      ],
      usuarios: [],
    },
  },
  ImportarResultado: {
    type: 'object',
    required: ['pools', 'asignaciones', 'omitidas', 'usuarios'],
    properties: {
      pools: { type: 'integer' },
      asignaciones: { type: 'integer' },
      omitidas: { type: 'integer' },
      usuarios: { type: 'integer' },
      direcciones: { type: 'integer', description: 'Direcciones IP fijas restauradas.' },
    },
    example: { pools: 0, asignaciones: 1, omitidas: 11, usuarios: 0 },
  },
};

// ---------------------------------------------------------------- ayudas para armar operaciones
const json = (schema, ejemplo) => ({
  'application/json': {
    schema: typeof schema === 'string' ? { $ref: `#/components/schemas/${schema}` } : schema,
    ...(ejemplo === undefined ? {} : { example: ejemplo }),
  },
});
const respuesta = (descripcion, schema, ejemplo) => ({ description: descripcion, ...(schema ? { content: json(schema, ejemplo) } : {}) });
const ref = (n) => ({ $ref: `#/components/responses/${n}` });
const cuerpo = (schema, ejemplo) => ({ required: true, content: json(schema, ejemplo) });
const param = (name, where, descripcion, schema = { type: 'string' }, required = where === 'path') => ({
  name,
  in: where,
  required,
  description: descripcion,
  schema,
});
const publico = [];
const CON_SESION = [{ bearerToken: [] }, { sesion: [] }, { basic: [] }];

const responses = {
  NoAutenticado: { description: 'Sin credenciales válidas (o token inválido, vencido o revocado).', content: json('Error') },
  SinPermiso: { description: 'Tu rol no alcanza (o no eres el dueño de la reserva).', content: json('Error') },
  NoEncontrado: { description: 'No existe.', content: json('Error') },
  LimiteExcedido: {
    description: 'Demasiadas peticiones (por actor, por IP, o demasiados intentos de autenticación fallidos desde la IP). Espera lo que dice `Retry-After`.',
    headers: { 'Retry-After': { description: 'Segundos que conviene esperar antes de reintentar.', schema: { type: 'integer' } } },
    content: json('ErrorRateLimit'),
  },
  Validacion: { description: 'La petición no cumple el contrato o una regla (código en `error`).', content: json('ErrorValidacion') },
};
const e401 = { 401: ref('NoAutenticado') };
const e403 = { 403: ref('SinPermiso') };
const e404 = { 404: ref('NoEncontrado') };
const e400 = { 400: ref('Validacion') };

/** @param {{tag: string, summary: string, description?: string, params?: any[], body?: any, ok: any, seguridad?: any[], extra?: any, id?: string}} o */
const op = ({ tag, summary, description, params, body, ok, seguridad = CON_SESION, extra = {}, id }) => ({
  tags: [tag],
  summary,
  ...(description ? { description } : {}),
  ...(id ? { operationId: id } : {}),
  ...(params ? { parameters: params } : {}),
  ...(body ? { requestBody: body } : {}),
  security: seguridad,
  responses: { ...ok, ...(seguridad.length ? e401 : {}), 429: ref('LimiteExcedido'), ...extra },
});

const ID_RESERVA = param('id', 'path', 'Identificador de la reserva (UUID).', { type: 'string', format: 'uuid' });
const ID_TOKEN = param('id', 'path', 'Identificador del token (UUID).', { type: 'string', format: 'uuid' });
const CLAVE_IDEM = param(
  'Idempotency-Key',
  'header',
  'Clave de idempotencia (1 a 128 caracteres: letras, números, . - _ :). Repetir la petición con la misma clave no duplica la reserva.',
  { type: 'string', maxLength: 128 },
  false,
);

// ---------------------------------------------------------------- rutas
function rutasDeSistema(p) {
  p['/healthz'] = {
    get: op({
      tag: 'Operación',
      summary: 'Vivo (liveness)',
      description: 'No toca la base de datos. Para `livenessProbe` y `HEALTHCHECK`.',
      ok: { 200: respuesta('El proceso responde.', 'Salud', { ok: true }) },
      seguridad: publico,
    }),
  };
  p['/readyz'] = {
    get: op({
      tag: 'Operación',
      summary: 'Listo (readiness)',
      description: 'Base alcanzable y esquema al día. 503 si no, o si el servicio se está apagando. Para `readinessProbe`, `healthCheckPath` y Cloud Run.',
      ok: {
        200: respuesta('Listo para atender.', 'Listo', { ok: true, esquema: { version: 4, minima: 4 } }),
        503: respuesta('Todavía no, o apagándose.', 'Listo', { ok: false, motivo: 'esquema_desactualizado' }),
      },
      seguridad: publico,
    }),
  };
  p['/api/health'] = {
    get: op({
      tag: 'Operación',
      summary: 'Salud (alias histórico)',
      description: 'Se conserva por compatibilidad; prefiere `/healthz` y `/readyz`.',
      ok: { 200: respuesta('Base alcanzable.', 'Salud', { ok: true }), 503: respuesta('Base no disponible.', 'Salud', { ok: false }) },
      seguridad: publico,
    }),
  };
  p['/metrics'] = {
    get: {
      ...op({
        tag: 'Operación',
        summary: 'Métricas en formato Prometheus',
        seguridad: publico,
        description:
          'Se protege con un token de lectura propio (`METRICS_TOKEN`, `Authorization: Bearer`) y/o por red (`METRICS_ALLOW_CIDRS`). Sin ninguno de los dos queda **deshabilitado** (404). No cuenta para el límite de peticiones. Medidores de reservas, tokens, pools y barredor salen de la base de datos (correctos con varias réplicas); los contadores son por réplica y Prometheus los suma.',
        ok: { 200: { description: 'Texto en formato de exposición de Prometheus.', content: { 'text/plain': { schema: { type: 'string' } } } } },
        extra: {
          401: respuesta('Token de métricas inválido.', 'Error'),
          403: respuesta('Dirección fuera de las redes permitidas.', 'Error'),
          404: respuesta('Métricas deshabilitadas.', 'Error'),
        },
      }),
      security: [{ metricsToken: [] }],
    },
  };
  p['/api/v1/openapi.json'] = {
    'x-alias-legado': '/api/openapi.json',
    get: op({ tag: 'Operación', summary: 'Este contrato (OpenAPI 3.1)', ok: { 200: respuesta('El documento OpenAPI.', { type: 'object' }) } }),
  };
  p['/api/v1/me'] = {
    'x-alias-legado': '/api/me',
    get: op({
      tag: 'Sesión',
      summary: 'Quién soy',
      description: 'Con un token de servicio, `modo` es `token`.',
      ok: { 200: respuesta('Identidad y rol actuales.', 'Me', { modo: 'token', usuario: 'svc:agente-redes', nombre: 'svc:agente-redes', rol: 'agente' }) },
    }),
  };
  p['/api/config'] = {
    get: op({ tag: 'Sesión', summary: 'Marca (nombre, subtítulo, logo)', ok: { 200: respuesta('Datos de marca.', 'Marca') }, seguridad: publico }),
  };
  p['/brand.css'] = {
    get: op({
      tag: 'Sesión',
      summary: 'Colores de la marca (CSS)',
      ok: { 200: { description: 'Hoja de estilos.', content: { 'text/css': { schema: { type: 'string' } } } } },
      seguridad: publico,
    }),
  };
  p['/brand/logo'] = {
    get: op({
      tag: 'Sesión',
      summary: 'Logo configurado',
      ok: {
        200: { description: 'Imagen (png, jpg, webp o svg).', content: { 'image/png': { schema: { type: 'string', format: 'binary' } } } },
        404: respuesta('No hay logo configurado.'),
      },
      seguridad: publico,
    }),
  };
  p['/auth/login'] = {
    get: op({
      tag: 'Sesión',
      summary: 'Inicia el login OIDC',
      description: 'Redirige al proveedor de identidad (solo en modo OIDC).',
      params: [param('next', 'query', 'Ruta a la que volver después de entrar.', { type: 'string' }, false)],
      ok: { 302: respuesta('Redirección al proveedor.') },
      seguridad: publico,
    }),
  };
  p['/auth/callback'] = {
    get: op({
      tag: 'Sesión',
      summary: 'Retorno del proveedor OIDC',
      ok: {
        302: respuesta('Sesión creada: redirige a la aplicación.'),
        400: respuesta('La solicitud de login expiró.'),
        403: respuesta('Dominio o rol sin acceso.'),
      },
      seguridad: publico,
    }),
  };
  p['/auth/logout'] = {
    post: op({
      tag: 'Sesión',
      summary: 'Cierra la sesión',
      ok: {
        200: respuesta(
          'Cookie borrada.',
          { type: 'object', properties: { ok: { type: 'boolean' }, redirect: { type: 'string' } } },
          { ok: true, redirect: '/auth/sesion-cerrada' },
        ),
      },
      seguridad: publico,
    }),
  };
  p['/auth/salir'] = {
    get: op({
      tag: 'Sesión',
      summary: 'Cierra la sesión en modo Basic (pide al navegador que olvide las credenciales)',
      description:
        'Basic Auth no tiene sesión en el servidor. Esta ruta responde siempre **401** con `WWW-Authenticate: Basic realm="IPAM"`; la interfaz la llama con ' +
        'credenciales falsas para que Chromium y Firefox reemplacen las guardadas. Es pública y no cuenta como intento fallido. Sin modo Basic redirige a `/`.',
      ok: {
        401: { description: 'Página «Sesión cerrada» con el desafío de Basic.', content: { 'text/html': { schema: { type: 'string' } } } },
        302: { description: 'Sin modo Basic: vuelve a la aplicación.' },
      },
      seguridad: publico,
    }),
  };
  p['/auth/sesion-cerrada'] = {
    get: op({
      tag: 'Sesión',
      summary: 'Página «sesión cerrada»',
      ok: { 200: { description: 'HTML.', content: { 'text/html': { schema: { type: 'string' } } } } },
      seguridad: publico,
    }),
  };
}

function rutasDeListaDeAsignaciones(p) {
  p['/api/v1/asignaciones'] = {
    'x-alias-legado': '/api/asignaciones',
    get: op({
      tag: 'Asignaciones',
      summary: 'Lista las asignaciones definitivas (paginada)',
      description:
        'Hasta 1000 por llamada (`limit`, 1000 por defecto) con `offset`; el total sin paginar viene en la cabecera `X-Total-Count`. Filtros: `pool`, `ambiente` y `q` ' +
        '(texto en CIDR, ID, proyecto/VPC, solicitante o ticket, sin distinguir mayúsculas). Orden: `orden` y `dir` (por defecto, lo más nuevo primero).',
      params: [
        param('limit', 'query', 'Cantidad máxima de filas (1 a 1000).', { type: 'integer', minimum: 1, maximum: 1000, default: 1000 }, false),
        param('offset', 'query', 'Filas que se saltan (para pasar de página).', { type: 'integer', minimum: 0, default: 0 }, false),
        param('pool', 'query', 'Solo las de este pool.', { type: 'string' }, false),
        param('ambiente', 'query', 'Solo las de pools de este ambiente.', { $ref: '#/components/schemas/Ambiente' }, false),
        param('q', 'query', 'Texto a buscar en CIDR, ID, proyecto/VPC, solicitante o ticket.', { type: 'string', maxLength: 100 }, false),
        param(
          'orden',
          'query',
          'Columna de orden.',
          { enum: ['fecha', 'cidr', 'pool', 'vpc', 'solicitante', 'ticket', 'origen', 'codigo', 'direcciones'] },
          false,
        ),
        param('dir', 'query', 'Sentido del orden.', { enum: ['asc', 'desc'] }, false),
      ],
      ok: {
        200: {
          ...respuesta('Asignaciones.', { type: 'array', items: { $ref: '#/components/schemas/Asignacion' } }),
          headers: { 'X-Total-Count': { description: 'Total de asignaciones que cumplen los filtros, sin paginar.', schema: { type: 'integer' } } },
        },
      },
      extra: { 400: respuesta('Parámetro inválido (limit, offset, ambiente, orden, dir o q).', 'Error') },
    }),
  };
}

function rutasDePoolsYAsignaciones(p) {
  p['/api/v1/pools'] = {
    'x-alias-legado': '/api/pools',
    get: op({
      tag: 'Pools',
      summary: 'Lista los pools con su uso y reservas vigentes',
      params: [
        param('ambiente', 'query', 'Filtra por ambiente.', { $ref: '#/components/schemas/Ambiente' }, false),
        param('tipo', 'query', 'Filtra por tipo (Nodos, Pods…).', { type: 'string' }, false),
      ],
      ok: { 200: respuesta('Pools.', { type: 'array', items: { $ref: '#/components/schemas/Pool' } }) },
    }),
  };
  p['/api/v1/pools/{id}/disponibilidad'] = {
    'x-alias-legado': '/api/pools/{id}/disponibilidad',
    get: op({
      tag: 'Pools',
      summary: 'Cuánto queda disponible en un pool, por máscara',
      description:
        'Para cada máscara desde la del pool hasta /32: cuántos bloques **alineados** caben enteros en lo libre (`bloques_libres`), cuántas direcciones tiene cada bloque (`direcciones`) y cuántas son utilizables (`utilizables`: un bloque ≤ /30 pierde la dirección de red y la de difusión). Cuenta asignaciones y reservas vigentes.',
      params: [param('id', 'path', 'Id del pool.')],
      ok: {
        200: respuesta(
          'Disponibilidad.',
          {
            type: 'object',
            required: ['pool', 'total', 'ocupadas', 'libres', 'por_mascara'],
            properties: {
              pool: { type: 'string' },
              cidr: { $ref: '#/components/schemas/Cidr' },
              total: { type: 'integer', description: 'Direcciones del pool.' },
              ocupadas: { type: 'integer' },
              libres: { type: 'integer' },
              por_mascara: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['mascara', 'direcciones', 'utilizables', 'bloques_libres', 'direcciones_libres'],
                  properties: {
                    mascara: { type: 'integer' },
                    direcciones: { type: 'integer' },
                    utilizables: { type: 'integer' },
                    bloques_libres: { type: 'integer' },
                    direcciones_libres: { type: 'integer' },
                  },
                },
              },
            },
          },
          {
            pool: 'dev-nodos',
            cidr: '10.210.0.0/20',
            total: 4096,
            ocupadas: 256,
            libres: 3840,
            por_mascara: [{ mascara: 24, direcciones: 256, utilizables: 254, bloques_libres: 15, direcciones_libres: 3840 }],
          },
        ),
      },
      extra: e404,
    }),
  };
  p['/api/v1/pools/{id}/libres'] = {
    'x-alias-legado': '/api/pools/{id}/libres',
    get: op({
      tag: 'Pools',
      summary: 'Rangos libres de un pool',
      description: 'Hasta 3 rangos libres de la máscara pedida (cuenta asignaciones y reservas vigentes).',
      params: [param('id', 'path', 'Id del pool.'), param('mascara', 'query', 'Tamaño del bloque (8 a 32).', { type: 'integer' }, true)],
      ok: {
        200: respuesta('Rangos libres.', { type: 'array', items: { $ref: '#/components/schemas/Cidr' } }, [
          '10.220.16.0/24',
          '10.220.17.0/24',
          '10.220.18.0/24',
        ]),
      },
      extra: { ...e400, ...e404 },
    }),
  };
  p['/api/v1/resumen'] = {
    'x-alias-legado': '/api/resumen',
    get: op({ tag: 'Pools', summary: 'Resumen general', ok: { 200: respuesta('Totales.', 'Resumen') } }),
  };
  p['/api/v1/asignaciones/{id}'] = {
    'x-alias-legado': '/api/asignaciones/{id}',
    delete: op({
      tag: 'Asignaciones',
      summary: 'Libera una asignación (solo admin)',
      params: [param('id', 'path', 'Id numérico de la asignación.')],
      ok: { 200: respuesta('Liberada.', 'Liberacion') },
      extra: { ...e403, ...e404 },
    }),
  };
  p['/api/v1/solicitudes'] = {
    'x-alias-legado': '/api/solicitudes',
    post: op({
      tag: 'Asignaciones',
      summary: 'Asigna un rango directo (solo admin)',
      description: 'Camino de las personas desde la interfaz. Los agentes usan reservas.',
      body: cuerpo('Solicitud', schemas.Solicitud.example),
      ok: { 201: respuesta('Asignado.', 'Asignacion') },
      extra: {
        ...e403,
        ...e400,
        404: respuesta('El pool no existe.', 'Error'),
        409: respuesta('Solapamiento: trae el conflicto y rangos sugeridos.', 'ErrorSolapamiento'),
      },
    }),
  };
  p['/api/v1/exportar.xlsx'] = {
    'x-alias-legado': '/api/exportar.xlsx',
    get: op({
      tag: 'Asignaciones',
      summary: 'Exporta a Excel',
      ok: {
        200: {
          description: 'Libro de Excel con las hojas «Segmentos» y «Pools».',
          content: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { schema: { type: 'string', format: 'binary' } } },
        },
      },
    }),
  };
  p['/api/v1/exportar.json'] = {
    'x-alias-legado': '/api/exportar.json',
    get: op({ tag: 'Respaldo', summary: 'Respaldo lógico completo (solo admin)', ok: { 200: respuesta('Respaldo.', 'Respaldo') }, extra: e403 }),
  };
  p['/api/v1/importar'] = {
    'x-alias-legado': '/api/importar',
    post: op({
      tag: 'Respaldo',
      summary: 'Restaura un respaldo (solo admin)',
      description: 'Todo o nada: si algún segmento se solapa, no se importa nada (409).',
      body: cuerpo('Respaldo', schemas.Respaldo.example),
      ok: { 200: respuesta('Importado.', 'ImportarResultado') },
      extra: {
        ...e403,
        400: respuesta('No es un respaldo válido.', 'Error'),
        409: respuesta('Hay solapamientos o pools inexistentes.', 'Error'),
        413: respuesta('Cuerpo demasiado grande.', 'Error'),
      },
    }),
  };
}

function rutasDeReservas(p) {
  p['/api/v1/reservas'] = {
    'x-alias-legado': '/api/reservas',
    post: op({
      tag: 'Reservas',
      id: 'reservar',
      summary: 'Reserva un rango (tentativo, expira solo)',
      description:
        'Rol `agente` o superior. La reserva **no es definitiva**: expira sola (24 h por defecto, máximo 72) salvo que se confirme. Idempotente con `Idempotency-Key`: misma clave y reserva viva → 200 con `repetida: true`; misma clave con reserva liberada o expirada → 409.',
      params: [CLAVE_IDEM],
      body: cuerpo('ReservaCrear', schemas.ReservaCrear.example),
      ok: {
        201: respuesta('Reservada.', 'ReservaRespuesta'),
        200: respuesta('Petición idempotente repetida: devuelve la reserva existente.', 'ReservaRespuesta'),
      },
      extra: {
        ...e400,
        ...e403,
        404: respuesta('El pool no existe.', 'Error'),
        409: respuesta('Solapamiento, clave de idempotencia ya usada (reserva liberada o expirada) o usada con otros parámetros.', 'ErrorSolapamiento'),
        422: respuesta('Ambiente y tipo ambiguos (o sin pools): trae `opciones`.', 'ErrorAmbiguo'),
        429: respuesta('Cuota de reservas vigentes excedida (`cuota_excedida`) o demasiadas peticiones (`rate_limit`).', {
          anyOf: [{ $ref: '#/components/schemas/ErrorCuota' }, { $ref: '#/components/schemas/ErrorRateLimit' }],
        }),
      },
    }),
    get: op({
      tag: 'Reservas',
      summary: 'Lista reservas',
      description: 'Cualquier rol puede ver. El estado es el real: una reservada vencida figura como expirada.',
      params: [
        param('estado', 'query', 'Filtra por estado.', { enum: ['reservada', 'confirmada', 'liberada', 'expirada'] }, false),
        param('pool', 'query', 'Filtra por pool.', { type: 'string' }, false),
        param('solicitante', 'query', 'Filtra por solicitante.', { type: 'string' }, false),
        param('limite', 'query', 'Máximo de filas (1 a 500, 200 por defecto).', { type: 'integer' }, false),
      ],
      ok: { 200: respuesta('Reservas, las más nuevas primero.', { type: 'array', items: { $ref: '#/components/schemas/Reserva' } }) },
      extra: e400,
    }),
  };
  p['/api/v1/reservas/{id}'] = {
    'x-alias-legado': '/api/reservas/{id}',
    get: op({ tag: 'Reservas', summary: 'Consulta una reserva', params: [ID_RESERVA], ok: { 200: respuesta('La reserva.', 'Reserva') }, extra: e404 }),
    delete: op({
      tag: 'Reservas',
      summary: 'Libera la reserva',
      description: 'Solo el dueño o un admin. Si estaba confirmada, borra también la asignación definitiva. Idempotente.',
      params: [ID_RESERVA],
      ok: { 200: respuesta('Liberada (o ya lo estaba: `repetida: true`).', 'ReservaLiberada') },
      extra: { ...e403, ...e404 },
    }),
  };
  p['/api/v1/reservas/{id}/confirmar'] = {
    'x-alias-legado': '/api/reservas/{id}/confirmar',
    post: op({
      tag: 'Reservas',
      id: 'confirmarReserva',
      summary: 'Confirma la reserva: pasa a asignación definitiva (origen `agente`)',
      description:
        'Solo el dueño o un admin. **Regla human-in-the-loop:** un agente debe indicar `aprobado_por` y `referencia` (quién aprobó y dónde consta). Idempotente. Una reserva liberada o expirada no se puede confirmar (409).',
      params: [ID_RESERVA],
      body: { required: false, content: json('ReservaConfirmar', schemas.ReservaConfirmar.example) },
      ok: { 200: respuesta('Confirmada (o ya lo estaba).', 'ReservaConfirmada') },
      extra: { ...e400, ...e403, ...e404, 409: respuesta('La reserva está liberada o expirada.', 'Error') },
    }),
  };
}

function rutasDeTokens(p) {
  p['/api/v1/tokens'] = {
    'x-alias-legado': '/api/tokens',
    post: op({
      tag: 'Tokens',
      summary: 'Crea un token de servicio (solo admin)',
      description: 'La respuesta incluye el token **una sola vez**. En la base solo queda su hash.',
      body: cuerpo('TokenCrear', schemas.TokenCrear.example),
      ok: { 201: respuesta('Creado.', 'TokenCreado') },
      extra: { ...e400, ...e403, 409: respuesta('Ya existe un token con ese nombre.', 'Error') },
    }),
    get: op({
      tag: 'Tokens',
      summary: 'Lista los tokens (solo admin)',
      description: 'Sin el token ni el hash.',
      ok: { 200: respuesta('Tokens.', { type: 'array', items: { $ref: '#/components/schemas/Token' } }) },
      extra: e403,
    }),
  };
  p['/api/v1/tokens/{id}'] = {
    'x-alias-legado': '/api/tokens/{id}',
    delete: op({
      tag: 'Tokens',
      summary: 'Revoca un token (solo admin)',
      description: 'Inmediato e idempotente.',
      params: [ID_TOKEN],
      ok: { 200: respuesta('Revocado.', 'Token') },
      extra: { ...e403, ...e404 },
    }),
  };
}

/** Direcciones IP fijas (interfaces, gateways, VIP…). */
function rutasDeDirecciones(p) {
  const ID = param('id', 'path', 'Id de la dirección.');
  p['/api/v1/direcciones'] = {
    'x-alias-legado': '/api/direcciones',
    get: op({
      tag: 'Direcciones IP',
      summary: 'Lista las direcciones IP fijas',
      params: [
        param('asignacion', 'query', 'Solo las de este segmento (id numérico).', { type: 'string' }, false),
        param('pool', 'query', 'Solo las de este pool.', { type: 'string' }, false),
        param('q', 'query', 'Busca en IP, equipo, interfaz, DNS, descripción y segmento.', { type: 'string' }, false),
      ],
      ok: { 200: respuesta('Direcciones.', { type: 'array', items: { $ref: '#/components/schemas/Direccion' } }) },
      extra: e400,
    }),
    post: op({
      tag: 'Direcciones IP',
      summary: 'Registra una IP fija (rol agente o más)',
      description:
        'Se ubica sola en su segmento. Fuera de un segmento exige `excepcion`. 409 `ip_repetida` si ya está en ese pool; 422 `ip_ambigua` si cae en varios pools (repite con `pool`).',
      body: cuerpo('DireccionCrear', schemas.DireccionCrear.example),
      ok: { 201: respuesta('Registrada.', 'Direccion', schemas.Direccion.example) },
      extra: { ...e400, ...e403, 409: respuesta('Ya registrada.', 'Error'), 422: respuesta('Cae en varios pools: indica `pool`.', 'Error') },
    }),
  };
  p['/api/v1/direcciones/{id}'] = {
    'x-alias-legado': '/api/direcciones/{id}',
    patch: op({
      tag: 'Direcciones IP',
      summary: 'Edita los datos de una IP fija (rol agente o más)',
      params: [ID],
      body: cuerpo('DireccionEditar', schemas.DireccionEditar.example),
      ok: { 200: respuesta('Editada.', 'Direccion') },
      extra: { ...e400, ...e403, ...e404 },
    }),
    delete: op({
      tag: 'Direcciones IP',
      summary: 'Elimina una IP fija (solo admin)',
      params: [ID],
      ok: { 200: respuesta('Eliminada.', { type: 'object' }) },
      extra: { ...e403, ...e404 },
    }),
  };
}

/** Alta, edición y baja de pools (solo admin). */
function rutasDeEdicionDePools(p) {
  p['/api/v1/pools'].post = op({
    tag: 'Pools',
    summary: 'Crea un bloque base (solo admin)',
    description: 'CIDR alineado de /8 a /30. 409 `pool_existe` si el nombre ya está y `pool_solapado` si choca con otro pool del mismo proveedor y ambiente.',
    body: cuerpo('PoolCrear', schemas.PoolCrear.example),
    ok: { 201: respuesta('Creado.', { type: 'object' }, schemas.PoolCrear.example) },
    extra: { ...e400, ...e403, 409: respuesta('Ya existe o se solapa con otro pool.', 'Error') },
  });
  p['/api/v1/pools/{id}'] = {
    'x-alias-legado': '/api/pools/{id}',
    patch: op({
      tag: 'Pools',
      summary: 'Edita el tipo y el proveedor de un pool (solo admin)',
      params: [param('id', 'path', 'Id del pool.')],
      body: cuerpo('PoolEditar', schemas.PoolEditar.example),
      ok: { 200: respuesta('Editado.', { type: 'object' }) },
      extra: { ...e400, ...e403, ...e404, 409: respuesta('El proveedor nuevo lo haría solaparse con otro pool.', 'Error') },
    }),
    delete: op({
      tag: 'Pools',
      summary: 'Elimina un pool vacío (solo admin)',
      description: 'Solo si no tiene asignaciones, reservas vigentes ni direcciones IP (409 `pool_en_uso` con el detalle).',
      params: [param('id', 'path', 'Id del pool.')],
      ok: { 200: respuesta('Eliminado.', { type: 'object' }) },
      extra: { ...e403, ...e404, 409: respuesta('El pool tiene segmentos, reservas o direcciones.', 'Error') },
    }),
  };
}

function rutasDeAdministracion(p) {
  p['/api/v1/usuarios'] = {
    'x-alias-legado': '/api/usuarios',
    get: op({
      tag: 'Administración',
      summary: 'Lista usuarios (solo admin)',
      ok: { 200: respuesta('Usuarios.', { type: 'array', items: { $ref: '#/components/schemas/Usuario' } }) },
      extra: e403,
    }),
  };
  p['/api/v1/usuarios'].post = op({
    tag: 'Administración',
    summary: 'Crea un usuario (solo admin)',
    description:
      '**Camino A (SSO):** pre-registra por correo con su rol; la identidad la guarda el proveedor OIDC. **Camino B (`local: true`, requiere `AUTH_LOCAL`):** crea una cuenta local con una **clave temporal que se devuelve una sola vez** (`clave_temporal`) y obliga a cambiarla. Nunca se guarda ni se audita la clave.',
    body: cuerpo('UsuarioCrear', schemas.UsuarioCrear.example),
    ok: { 201: respuesta('Usuario creado.', { type: 'object' }, { email: 'ana@empresa.example', nombre: 'Ana', rol: 'solicitante', local: false }) },
    extra: { ...e400, ...e403, 409: respuesta('Ya existe un usuario con ese correo o nombre.', 'Error') },
  });
  const accion = (resumen, descripcion) =>
    op({
      tag: 'Administración',
      summary: resumen,
      description: descripcion,
      params: [param('email', 'path', 'Correo o nombre de usuario.')],
      ok: { 200: respuesta('Hecho.', { type: 'object' }, { email: 'ana@empresa.example' }) },
      extra: { ...e400, ...e403, ...e404, 409: respuesta('No puedes hacerlo sobre tu propia cuenta.', 'Error') },
    });
  p['/api/v1/usuarios/{email}/desactivar'] = {
    'x-alias-legado': '/api/usuarios/{email}/desactivar',
    post: accion(
      'Da de baja a un usuario (solo admin)',
      'No puede entrar mientras esté desactivado; se conserva su historial de auditoría. No puedes desactivarte a ti mismo.',
    ),
  };
  p['/api/v1/usuarios/{email}/activar'] = {
    'x-alias-legado': '/api/usuarios/{email}/activar',
    post: accion('Reactiva a un usuario (solo admin)', 'Revierte la baja.'),
  };
  p['/api/v1/usuarios/{email}/restablecer-clave'] = {
    'x-alias-legado': '/api/usuarios/{email}/restablecer-clave',
    post: accion(
      'Restablece la clave de una cuenta local (solo admin)',
      'Devuelve una clave temporal **una sola vez** (`clave_temporal`) y obliga a cambiarla. Solo para cuentas locales.',
    ),
  };
  const importacion = (resumen, descripcion, ejemplo) =>
    op({
      tag: 'Administración',
      summary: resumen,
      description: descripcion,
      body: cuerpo('ImportacionSolicitud', schemas.ImportacionSolicitud.example),
      ok: { 200: respuesta('Resultado.', { type: 'object' }, ejemplo) },
      extra: { ...e400, ...e403, 409: respuesta('La base de datos rechazó la importación (no se importó nada).', 'Error') },
    });
  p['/api/v1/importaciones/simular'] = {
    'x-alias-legado': '/api/importaciones/simular',
    post: importacion(
      'Simula la importación de segmentos desde Excel o CSV (solo admin)',
      'Lee el archivo y dice qué pasaría con cada fila **sin escribir nada**. Estados: `ok`, `ya_existe` (se omite), `solapa_otro_pool` (un admin debe aprobarlo o rechazarlo), `choca_mismo_pool` (no importable) e `invalida`. Si no hay pools que contengan los segmentos, propone crear uno por proveedor, ambiente y familia de red (`pools_a_crear`).',
      { total: 2, resumen: { ok: 2, ya_existe: 0, solapa_otro_pool: 0, choca_mismo_pool: 0, invalida: 0 }, pools_a_crear: [], filas: [] },
    ),
  };
  p['/api/v1/importaciones/aplicar'] = {
    'x-alias-legado': '/api/importaciones/aplicar',
    post: importacion(
      'Importa los segmentos válidos (solo admin)',
      'Importa las filas `ok` y las `solapa_otro_pool` cuyo número venga en `aprobar`. **Todo o nada**; crea los pools automáticos que hagan falta; origen `importado`; queda en la auditoría. Importar dos veces el mismo archivo no duplica (`ya_existe`).',
      { importadas: 2, pools_creados: 1, omitidas: 0, rechazadas_por_solapamiento: 0, no_importables: 0, aprobadas: 0 },
    ),
  };
  p['/api/v1/yo/clave'] = {
    'x-alias-legado': '/api/yo/clave',
    post: op({
      tag: 'Sesión',
      summary: 'Cambia la contraseña de la cuenta local propia',
      body: cuerpo('CambioClave', { actual: '(clave actual)', nueva: '(clave nueva de al menos 12 caracteres)' }),
      ok: {
        200: respuesta(
          'Contraseña cambiada.',
          { type: 'object', properties: { email: { type: 'string' }, cambiada: { type: 'boolean' } } },
          { email: 'ana', cambiada: true },
        ),
      },
      extra: { ...e400, ...e401, ...e403 },
    }),
  };
  p['/api/v1/usuarios/{email}'] = {
    'x-alias-legado': '/api/usuarios/{email}',
    delete: accion('Elimina un usuario (solo admin)', 'Borra la cuenta. Para conservar el historial, prefiere desactivar. No puedes eliminarte a ti mismo.'),
    put: op({
      tag: 'Administración',
      summary: 'Asigna el rol de un usuario (solo admin)',
      params: [param('email', 'path', 'Correo del usuario.')],
      body: cuerpo('UsuarioRol', schemas.UsuarioRol.example),
      ok: {
        200: respuesta(
          'Rol asignado.',
          { type: 'object', properties: { email: { type: 'string' }, rol: { type: ['string', 'null'] } } },
          { email: 'ana@empresa.example', rol: 'solicitante' },
        ),
      },
      extra: { ...e400, ...e403 },
    }),
  };
  p['/api/v1/auditoria'] = {
    'x-alias-legado': '/api/auditoria',
    get: op({
      tag: 'Administración',
      summary: 'Bitácora de auditoría, solo lectura (solo admin)',
      description:
        'Últimas 200 filas. La tabla es de solo inserción. Con `pool` y/o `cidr` devuelve solo el historial de ese pool o segmento (lo usa la ficha de detalle).',
      params: [
        param('pool', 'query', 'Solo las acciones sobre este pool.', { type: 'string' }, false),
        param('cidr', 'query', 'Solo las acciones sobre este segmento (CIDR exacto).', { type: 'string' }, false),
      ],
      ok: { 200: respuesta('Auditoría.', { type: 'array', items: { $ref: '#/components/schemas/AuditoriaFila' } }) },
      extra: e403,
    }),
  };
  p['/api/v1/eventos'] = {
    'x-alias-legado': '/api/eventos',
    get: op({
      tag: 'Administración',
      summary: 'Últimos eventos',
      ok: { 200: respuesta('Eventos.', { type: 'array', items: { $ref: '#/components/schemas/Evento' } }) },
    }),
  };
}

function rutasDeJira(p) {
  p['/api/v1/jira/estado'] = {
    'x-alias-legado': '/api/jira/estado',
    get: op({ tag: 'Jira', summary: 'Estado de la integración saliente con Jira', ok: { 200: respuesta('Estado.', 'JiraEstado') } }),
  };
  p['/api/v1/jira/simular'] = {
    'x-alias-legado': '/api/jira/simular',
    post: op({
      tag: 'Jira',
      summary: 'Simula un ticket entrante (demo)',
      body: cuerpo('JiraSimular', schemas.JiraSimular.example),
      ok: { 200: respuesta('Reserva creada, pendiente de aprobación de un admin.', 'JiraResultado') },
      extra: {
        ...e403,
        404: respuesta('Sin pool, o el simulador no está habilitado en este entorno (producción sin ENABLE_SIMULADOR).', 'Error'),
        409: respuesta('Sin espacio o solapamiento.', 'Error'),
        422: respuesta('No hay pool para ese ambiente y tipo.', 'Error'),
      },
    }),
  };
  p['/webhook/jira'] = {
    post: op({
      tag: 'Jira',
      summary: 'Webhook de Jira (firmado)',
      description:
        'Firma HMAC-SHA256 en `x-hub-signature-256` sobre `<x-ipam-timestamp>.<cuerpo>`, comparada en tiempo constante, con una ventana de ±5 minutos (un reenvío dentro de ella es idempotente por ticket). En producción sin `JIRA_WEBHOOK_SECRET` queda deshabilitado (503). **No asigna directo:** crea una reserva tentativa (24 h por defecto) que un **admin debe aprobar** en la pestaña Reservas; recién ahí nace la asignación y se actualiza el ticket. Sin aprobación, expira sola. Es idempotente por ticket.',
      params: [
        param('x-ipam-timestamp', 'header', 'Segundos desde 1970 (UTC) en que se firmó; se rechaza lo de hace más de 5 minutos.', { type: 'string' }, true),
        param('x-hub-signature-256', 'header', 'sha256=HMAC-SHA256(JIRA_WEBHOOK_SECRET, "<timestamp>.<cuerpo>")', { type: 'string' }, true),
      ],
      body: cuerpo('JiraTicket', schemas.JiraTicket.example),
      ok: { 200: respuesta('Reserva creada, pendiente de aprobación.', 'JiraResultado') },
      seguridad: publico,
      extra: {
        429: ref('LimiteExcedido'),
        400: respuesta('Faltan campos.', 'Error'),
        401: respuesta('Firma inválida.', 'Error'),
        409: respuesta('Sin espacio.', 'Error'),
        422: respuesta('Sin pool.', 'Error'),
        503: respuesta('Webhook deshabilitado.', 'Error'),
      },
    }),
  };
}

function rutas() {
  const p = {};
  rutasDeSistema(p);
  rutasDePoolsYAsignaciones(p);
  rutasDeListaDeAsignaciones(p);
  rutasDeEdicionDePools(p);
  rutasDeDirecciones(p);
  rutasDeReservas(p);
  rutasDeTokens(p);
  rutasDeAdministracion(p);
  rutasDeJira(p);
  return p;
}

/**
 * Documento OpenAPI 3.1 completo.
 * @param {{servidor?: string}} [o] URL pública del servicio (opcional).
 */
function construirOpenApi({ servidor = '/' } = {}) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'IPAM · API de segmentos de red',
      version,
      summary: 'Asignación de rangos IP sin solapes, con reservas tentativas para agentes.',
      description: [
        'IPAM propio: pools por ambiente y tipo, asignaciones definitivas y **reservas tentativas** pensadas para agentes automáticos.',
        '',
        '**Cómo se autentica un agente:** `Authorization: Bearer ipam_…` (token de servicio creado por un admin). No necesita `X-Requested-With` (no hay cookie). Las personas usan cookie de sesión (OIDC) o Basic y deben enviar `X-Requested-With: ipam` en los cambios.',
        '',
        '**Flujo recomendado:** reservar (con `Idempotency-Key`) → una persona aprueba el cambio en tu pipeline → confirmar con `aprobado_por` y `referencia` → o liberar si algo falla. Una reserva sin confirmar **expira sola**.',
        '',
        '**Versionado:** las rutas `/api/v1/…` son las principales; `/api/…` sigue funcionando como alias compatible.',
        '',
        '**Límites:** por actor (token o usuario) y por IP, con ventana deslizante de un minuto (por defecto 120 lecturas y 30 escrituras por actor). Al excederlos, 429 con `Retry-After`. Las respuestas traen `RateLimit-Limit`, `RateLimit-Remaining` y `RateLimit-Reset` (segundos). Los intentos de autenticación fallidos tienen un límite más estricto por IP (freno a la fuerza bruta).',
        '',
        'Todos los errores traen `error` (código estable), `mensaje` (español) y `request_id` (también en la cabecera `X-Request-Id`, que puedes enviar tú para correlacionar).',
      ].join('\n'),
    },
    servers: [{ url: servidor }],
    tags: [
      { name: 'Reservas', description: 'Reservas tentativas para agentes.' },
      { name: 'Tokens', description: 'Credenciales de servicio.' },
      { name: 'Pools' },
      { name: 'Asignaciones' },
      { name: 'Direcciones IP', description: 'IPs fijas de interfaces, gateways, VIP…' },
      { name: 'Respaldo' },
      { name: 'Administración' },
      { name: 'Jira' },
      { name: 'Sesión' },
      { name: 'Operación', description: 'Sondas de salud y contrato.' },
    ],
    paths: rutas(),
    components: {
      securitySchemes: {
        bearerToken: { type: 'http', scheme: 'bearer', bearerFormat: 'ipam_ + 43 caracteres', description: 'Token de servicio (rol lector o agente).' },
        sesion: {
          type: 'apiKey',
          in: 'cookie',
          name: 'ipam_sesion',
          description: 'Cookie de sesión OIDC (HttpOnly, SameSite). Los cambios exigen `X-Requested-With: ipam`.',
        },
        metricsToken: { type: 'http', scheme: 'bearer', description: 'METRICS_TOKEN: solo sirve para leer /metrics.' },
        basic: { type: 'http', scheme: 'basic', description: 'Modo Basic de un solo usuario (POC). Los cambios exigen `X-Requested-With: ipam`.' },
      },
      responses,
      schemas,
    },
  };
}

module.exports = { construirOpenApi, schemas };
