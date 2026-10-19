-- Datos de ejemplo (solo para demo). Idempotente.
insert into pools (id,tipo,ambiente,proveedor,cidr) values
 ('gke-nodos-prod','Nodos','prod','GCP','10.10.0.0/16'),
 ('gke-pods-prod','Pods','prod','GCP','10.64.0.0/12'),
 ('gke-svc-prod','Servicios','prod','GCP','10.96.0.0/16'),
 ('gke-cp-prod','Control plane','prod','GCP','172.16.0.0/20'),
 ('gke-nodos-qa','Nodos','qa','GCP','10.20.0.0/16'),
 ('onprem-lan-dev','Nodos','dev','On-prem','192.168.0.0/16')
on conflict (id) do nothing;

insert into asignaciones (pool_id,cidr,vpc,solicitante,ticket,origen,creado_en) values
 ('gke-nodos-prod','10.10.0.0/20','vpc-pagos','mlopez','NET-120','semilla','2026-09-14'),
 ('gke-nodos-prod','10.10.16.0/20','vpc-clientes','jperez','NET-128','semilla','2026-09-22'),
 ('gke-nodos-prod','10.10.32.0/21','vpc-core','mlopez','NET-131','semilla','2026-09-25'),
 ('gke-pods-prod','10.64.0.0/21','vpc-pagos','mlopez','NET-121','semilla','2026-09-14'),
 ('gke-pods-prod','10.64.8.0/21','vpc-clientes','jperez','NET-142','semilla','2026-10-02'),
 ('gke-pods-prod','10.64.32.0/19','vpc-core','cquiroz','NET-133','semilla','2026-09-28'),
 ('gke-svc-prod','10.96.0.0/20','vpc-pagos','mlopez','NET-122','semilla','2026-09-14'),
 ('gke-cp-prod','172.16.0.0/28','vpc-pagos','mlopez','NET-123','semilla','2026-09-14'),
 ('gke-cp-prod','172.16.0.16/28','vpc-clientes','jperez','NET-129','semilla','2026-09-22'),
 ('gke-nodos-qa','10.20.0.0/20','vpc-qa','cquiroz','NET-110','semilla','2026-09-02'),
 ('onprem-lan-dev','192.168.0.0/24','lan-dev-a','cquiroz','NET-101','semilla','2026-08-20'),
 ('onprem-lan-dev','192.168.1.0/24','lan-dev-b','cquiroz','NET-102','semilla','2026-08-20')
on conflict do nothing;
