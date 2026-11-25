-- Datos de PRUEBA para el agente de redes: pools y tabla «ambiente + uso → pool» de lab, qa, pre y prod (dev ya existe en el POC).
-- TODOS los rangos son FICTICIOS, distintos entre ambientes (los rangos no se repiten) y se reemplazan por los reales cuando todo funcione.
-- Idempotente. Se ejecuta DESPUÉS de db/schema.sql, con el mismo rol y esquema que la aplicación usa para migrar.
--   Nodos:     10.20X.0.0/16 (una por ambiente)         máscara máxima /29 (una subred de GCP no baja de ahí)
--   Pods:      un /12 por ambiente (10.16/12 lab … 10.64/12 prod)   defecto /20, entre /14 y /24
--   Servicios: 10.21X.0.0/16 (una por ambiente)         defecto /24, entre /16 y /27
insert into pools (id, tipo, ambiente, proveedor, cidr, mascara_defecto, mascara_minima, mascara_maxima) values
  ('lab-nodos',  'Nodos',     'lab',  'GCP', '10.201.0.0/16', null, 20, 29),
  ('qa-nodos',   'Nodos',     'qa',   'GCP', '10.202.0.0/16', null, 20, 29),
  ('pre-nodos',  'Nodos',     'pre',  'GCP', '10.203.0.0/16', null, 20, 29),
  ('prod-nodos', 'Nodos',     'prod', 'GCP', '10.204.0.0/16', null, 20, 29),
  ('lab-pods',   'Pods',      'lab',  'GCP', '10.16.0.0/12',  20, 14, 24),
  ('qa-pods',    'Pods',      'qa',   'GCP', '10.32.0.0/12',  20, 14, 24),
  ('pre-pods',   'Pods',      'pre',  'GCP', '10.48.0.0/12',  20, 14, 24),
  ('prod-pods',  'Pods',      'prod', 'GCP', '10.64.0.0/12',  20, 14, 24),
  ('lab-svc',    'Servicios', 'lab',  'GCP', '10.211.0.0/16', 24, 16, 27),
  ('qa-svc',     'Servicios', 'qa',   'GCP', '10.212.0.0/16', 24, 16, 27),
  ('pre-svc',    'Servicios', 'pre',  'GCP', '10.213.0.0/16', 24, 16, 27),
  ('prod-svc',   'Servicios', 'prod', 'GCP', '10.214.0.0/16', 24, 16, 27)
on conflict (id) do nothing;

insert into pool_uso (ambiente, uso, pool_id) values
  ('lab',  'subnet', 'lab-nodos'),  ('lab',  'pods', 'lab-pods'),  ('lab',  'servicios', 'lab-svc'),
  ('qa',   'subnet', 'qa-nodos'),   ('qa',   'pods', 'qa-pods'),   ('qa',   'servicios', 'qa-svc'),
  ('pre',  'subnet', 'pre-nodos'),  ('pre',  'pods', 'pre-pods'),  ('pre',  'servicios', 'pre-svc'),
  ('prod', 'subnet', 'prod-nodos'), ('prod', 'pods', 'prod-pods'), ('prod', 'servicios', 'prod-svc')
on conflict (ambiente, uso) do nothing;
