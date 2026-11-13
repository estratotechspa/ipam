'use strict';
// Servidor de demostración local interactivo para previsualizar la interfaz Cyber Network Console.
// Carga datos semilla ficticios en memoria para explorar la UI sin requerir PostgreSQL ni Docker.
const path = require('node:path');
const express = require('express');
const { reconciliarSubredes } = require('../src/dominio/reconciliacion');
const { size, calcularFragmentacion, libres } = require('../src/dominio/cidr');

const app = express();
const PUERTO = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Datos semilla realistas
const POOLS = [
  {
    id: 'gke-nodos-prod',
    tipo: 'Nodos',
    ambiente: 'prod',
    proveedor: 'GCP',
    cidr: '10.10.0.0/16',
    uso: 0.45,
    uso_reservado: 0.1,
    asignaciones: 4,
    reservas_vigentes: 1,
  },
  {
    id: 'gke-pods-prod',
    tipo: 'Pods',
    ambiente: 'prod',
    proveedor: 'GCP',
    cidr: '10.64.0.0/12',
    uso: 0.32,
    uso_reservado: 0.05,
    asignaciones: 5,
    reservas_vigentes: 0,
  },
  {
    id: 'gke-svc-prod',
    tipo: 'Servicios',
    ambiente: 'prod',
    proveedor: 'GCP',
    cidr: '10.96.0.0/16',
    uso: 0.2,
    uso_reservado: 0.0,
    asignaciones: 3,
    reservas_vigentes: 0,
  },
  {
    id: 'gke-cp-prod',
    tipo: 'Control plane',
    ambiente: 'prod',
    proveedor: 'GCP',
    cidr: '172.16.0.0/20',
    uso: 0.15,
    uso_reservado: 0.0,
    asignaciones: 2,
    reservas_vigentes: 0,
  },
  {
    id: 'aws-vpc-prod',
    tipo: 'Nodos',
    ambiente: 'prod',
    proveedor: 'AWS',
    cidr: '10.20.0.0/16',
    uso: 0.65,
    uso_reservado: 0.12,
    asignaciones: 6,
    reservas_vigentes: 2,
  },
  {
    id: 'azure-aks-dev',
    tipo: 'Pods',
    ambiente: 'dev',
    proveedor: 'Azure',
    cidr: '10.30.0.0/16',
    uso: 0.28,
    uso_reservado: 0.0,
    asignaciones: 3,
    reservas_vigentes: 0,
  },
  {
    id: 'onprem-lan-dev',
    tipo: 'Nodos',
    ambiente: 'dev',
    proveedor: 'On-prem',
    cidr: '192.168.0.0/16',
    uso: 0.18,
    uso_reservado: 0.0,
    asignaciones: 2,
    reservas_vigentes: 0,
  },
];

const ASIGNACIONES = [
  {
    id: 1,
    codigo: 'ASG-000001',
    pool_id: 'gke-nodos-prod',
    cidr: '10.10.0.0/20',
    vpc: 'vpc-pagos',
    solicitante: 'mlopez',
    ticket: 'NET-120',
    origen: 'semilla',
    creado_en: '2026-09-14T10:00:00Z',
    proyecto: 'pagos-core',
    subred: 'sub-pagos-a',
  },
  {
    id: 2,
    codigo: 'ASG-000002',
    pool_id: 'gke-nodos-prod',
    cidr: '10.10.16.0/20',
    vpc: 'vpc-clientes',
    solicitante: 'jperez',
    ticket: 'NET-128',
    origen: 'semilla',
    creado_en: '2026-09-22T11:30:00Z',
    proyecto: 'crm-clientes',
    subred: 'sub-clientes-b',
  },
  {
    id: 3,
    codigo: 'ASG-000003',
    pool_id: 'gke-nodos-prod',
    cidr: '10.10.32.0/21',
    vpc: 'vpc-core',
    solicitante: 'mlopez',
    ticket: 'NET-131',
    origen: 'semilla',
    creado_en: '2026-09-25T09:15:00Z',
    proyecto: 'infra-base',
    subred: 'sub-core-01',
  },
  {
    id: 4,
    codigo: 'ASG-000004',
    pool_id: 'gke-pods-prod',
    cidr: '10.64.0.0/18',
    vpc: 'vpc-pagos',
    solicitante: 'cquiroz',
    ticket: 'NET-142',
    origen: 'semilla',
    creado_en: '2026-10-02T14:20:00Z',
    proyecto: 'pagos-core',
    subred: 'sub-pods-01',
  },
  {
    id: 5,
    codigo: 'ASG-000005',
    pool_id: 'aws-vpc-prod',
    cidr: '10.20.1.0/24',
    vpc: 'vpc-prod-core',
    solicitante: 'agente-ia',
    ticket: 'NET-155',
    origen: 'agente',
    creado_en: '2026-11-10T08:00:00Z',
    proyecto: 'infra-latam',
    subred: 'sub-microservicios',
  },
  {
    id: 6,
    codigo: 'ASG-000006',
    pool_id: 'aws-vpc-prod',
    cidr: '10.20.2.0/24',
    vpc: 'vpc-prod-core',
    solicitante: 'agente-ia',
    ticket: 'NET-156',
    origen: 'agente',
    creado_en: '2026-11-10T08:05:00Z',
    proyecto: 'infra-latam',
    subred: 'sub-apigw',
  },
  {
    id: 7,
    codigo: 'ASG-000007',
    pool_id: 'onprem-lan-dev',
    cidr: '192.168.0.0/24',
    vpc: 'lan-dev-a',
    solicitante: 'cquiroz',
    ticket: 'NET-101',
    origen: 'manual',
    creado_en: '2026-08-20T12:00:00Z',
    proyecto: 'laboratorio',
    subred: 'sub-dev-lan',
  },
];

const RESERVAS = [
  {
    id: 'res-001',
    pool_id: 'gke-nodos-prod',
    cidr: '10.10.40.0/21',
    vpc: 'vpc-pagos',
    solicitante: 'cquiroz',
    ticket: 'NET-180',
    estado: 'reservada',
    expira_en: new Date(Date.now() + 18 * 3600000).toISOString(),
    creado_en: new Date().toISOString(),
  },
  {
    id: 'res-002',
    pool_id: 'aws-vpc-prod',
    cidr: '10.20.10.0/24',
    vpc: 'vpc-prod-core',
    solicitante: 'agente-redes',
    ticket: 'NET-185',
    estado: 'reservada',
    expira_en: new Date(Date.now() + 6 * 3600000).toISOString(),
    creado_en: new Date().toISOString(),
  },
];

// Configuración de marca y telemetría
app.get('/api/config', (_req, res) => {
  res.json({
    nombre: 'IPAM',
    subtitulo: 'Cyber Network Console',
    pie: 'Antigravity Autonomous Network Engine · Dark Ops v0.6.0',
  });
});

// Usuario actual (simulación de sesión de administrador)
app.get('/api/v1/me', (_req, res) => {
  res.json({
    modo: 'none',
    usuario: 'cquiroz',
    rol: 'admin',
    nombre: 'Carlos Quiroz',
    local: false,
  });
});

// Listado de Pools
app.get('/api/v1/pools', (_req, res) => {
  res.json(POOLS);
});

// Listado de Asignaciones
app.get('/api/v1/asignaciones', (req, res) => {
  const pool = req.query.pool;
  const filtradas = pool ? ASIGNACIONES.filter((a) => a.pool_id === pool) : ASIGNACIONES;
  res.json(filtradas);
});

// Listado de Reservas
app.get('/api/v1/reservas', (_req, res) => {
  res.json(RESERVAS);
});

// Disponibilidad y mapa de bloques de un pool
app.get('/api/v1/pools/:id/disponibilidad', (req, res) => {
  const p = POOLS.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'pool_no_encontrado' });
  const ocupadas = ASIGNACIONES.filter((a) => a.pool_id === p.id).map((a) => a.cidr);
  const frag = calcularFragmentacion(p.cidr, ocupadas);
  res.json({
    pool: p.id,
    cidr: p.cidr,
    tamano_total: size(p.cidr),
    fragmentacion: frag,
    bloques_libres: libres(p.cidr, ocupadas, 24).slice(0, 5),
  });
});

// Reconciliación de Deriva de Nube (usa el motor de reconciliación)
app.post('/api/v1/reconciliacion', (req, res) => {
  const subredesNube = req.body?.subredes_nube || [];
  const asignacionesIpam = ASIGNACIONES.map((a) => ({
    cidr: a.cidr,
    vpc: a.vpc,
    proyecto: a.proyecto || '',
    ambiente: 'prod',
  }));
  const resultado = reconciliarSubredes(subredesNube, asignacionesIpam);
  res.json(resultado);
});

// Auditoría y tokens de prueba
app.get('/api/v1/tokens', (_req, res) => res.json([]));
app.get('/api/v1/usuarios', (_req, res) => res.json([]));
app.get('/api/v1/clusteres', (_req, res) => res.json([]));
app.get('/api/v1/direcciones', (_req, res) => res.json([]));
app.get('/api/v1/jira/solicitudes', (_req, res) => res.json([]));

// Sondas de salud
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/readyz', (_req, res) => res.json({ ok: true, version: '0.6.0' }));

const server = app.listen(PUERTO, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════════════════╗
║                   CYBER NETWORK CONSOLE (DARK OPS IPAM)                   ║
╠═══════════════════════════════════════════════════════════════════════════╣
║  Servidor activo en: http://localhost:${PUERTO}                           ║
║  Modo: Demostración Interactiva en Memoria (Zero-Setup)                   ║
║  UI: Dark Ops Aesthetic / WCAG AA Compliant / Telemetría en Vivo          ║
╚═══════════════════════════════════════════════════════════════════════════╝
  `);
});

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
