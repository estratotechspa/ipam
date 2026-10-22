-- Datos de ejemplo del POC. Idempotente. -- DATOS FICTICIOS
-- Todos los rangos son inventados (10.210/220/230/240.0.0/16), divididos en pools Nodos / Pods / Servicios. No representan ninguna red real.
insert into pools (id,tipo,ambiente,proveedor,cidr) values
 ('dev-nodos','Nodos','dev','GCP','10.210.0.0/20'),
 ('dev-pods','Pods','dev','GCP','10.210.16.0/20'),
 ('dev-servicios','Servicios','dev','GCP','10.210.32.0/20'),
 ('qa-nodos','Nodos','qa','GCP','10.220.0.0/20'),
 ('qa-pods','Pods','qa','GCP','10.220.16.0/20'),
 ('qa-servicios','Servicios','qa','GCP','10.220.32.0/20'),
 ('pre-nodos','Nodos','pre','GCP','10.230.0.0/20'),
 ('pre-pods','Pods','pre','GCP','10.230.16.0/20'),
 ('pre-servicios','Servicios','pre','GCP','10.230.32.0/20'),
 ('prod-nodos','Nodos','prod','GCP','10.240.0.0/20'),
 ('prod-pods','Pods','prod','GCP','10.240.16.0/20'),
 ('prod-servicios','Servicios','prod','GCP','10.240.32.0/20')
on conflict (id) do nothing;

insert into asignaciones (pool_id,cidr,vpc,solicitante,ticket,origen,creado_en) values
 ('dev-nodos','10.210.0.0/24','vpc-ejemplo-a','demo','DEMO-1','semilla','2026-09-01'),
 ('dev-pods','10.210.16.0/22','vpc-ejemplo-a','demo','DEMO-1','semilla','2026-09-01'),
 ('qa-nodos','10.220.0.0/24','vpc-ejemplo-b','demo','DEMO-2','semilla','2026-09-02')
on conflict do nothing;
