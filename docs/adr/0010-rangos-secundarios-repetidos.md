# ADR 0010 · Rangos secundarios (Pods y Services) repetidos entre VPC

- **Estado:** aceptada · **Fecha:** 2026-11-10 · **Decide:** gerencia de EstratoTech

## Contexto
Las asignaciones importadas muestran el mismo rango secundario en VPC distintas (por ejemplo `10.212.0.0/16`). Dos VPC que no se comunican entre sí pueden repetirlo sin problema técnico; si algún día se conectan (peering, Network Connectivity Center, VPN), un rango repetido obliga a renumerar.

## Decisión
- **Se permite repetir** un rango secundario entre VPC. IPAM no lo rechaza ni bloquea la migración por eso.
- **Se evita en lo posible:** IPAM no genera repetidos. Los Pods y Services nuevos salen de un pool compartido por ambiente (`pod-gke-<ambiente>`, `servicios-gke-<ambiente>`), y dentro de un pool la restricción `sin_solapamiento` (`pool_id` + `cidr`) impide que dos asignaciones se pisen. Un repetido solo puede venir de datos importados o de una carga manual.
- Los repetidos que ya existen **se conservan**. `npm run migrar-vpc` no los mueve ni los trata como problema.
- Al conectar dos VPC, quien lo pida debe revisar primero si comparten algún rango.

## Consecuencias
- (+) No se renumera nada existente ni se frena la migración.
- (−) La restricción de la base de datos es por pool: no detecta un repetido entre pools distintos. Hoy se resuelve con revisión humana.
- Pendiente (no urgente): un aviso en la simulación de importación y en el agente de redes cuando un rango secundario ya existe en otra VPC.
