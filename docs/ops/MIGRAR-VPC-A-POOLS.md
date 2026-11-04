# Migrar un pool de ambiente a pools hijos por VPC

Caso: `dev-gcp-ccla` guarda ~100 asignaciones de 5 VPC (4 proyectos hub) en un solo pool. Con el modelo «el pool es la VPC» cada VPC pasa a ser un **pool hijo** de `dev-gcp-ccla`, con su proyecto, su nombre de VPC y su bloque. Las asignaciones **se mueven** al hijo (no se copian) y las IP fijas siguen a su segmento.

> **Nada de esto se ejecuta solo.** El comando simula por defecto y solo escribe con `--aplicar`, con el usuario migrador y después de que una persona revise el plan. No lo ejecutes en el entorno compartido sin una confirmación explícita.

## Por qué no se usa `/importaciones`
`/importar` y la importación masiva **agregan** segmentos nuevos; no mueven los que ya están. Usarlos aquí duplicaría cada asignación (en el padre y en el hijo). Para este caso existe `npm run migrar-vpc`, que sí **simula antes de aplicar** (mismo criterio que `/importaciones/simular` → `/aplicar`) y mueve en una sola transacción.

## Pasos
1. **Esquema 18** aplicado (`npm run migrar`) y **respaldo previo** de la base ([RESPALDO-Y-RECUPERACION](RESPALDO-Y-RECUPERACION.md)); también `GET /api/v1/exportar.json`.
2. **Simular** (no escribe nada). Usa `DATABASE_URL_MIGRACION` (o `DATABASE_URL`):
   ```bash
   npm run migrar-vpc -- --pool dev-gcp-ccla --salida plan.json
   ```
   El plan lista, por VPC: proyecto, el bloque más chico que contiene sus asignaciones, el id del pool y cuántas asignaciones mueve. En `problemas` trae lo que una persona debe resolver:

   | Problema | Qué significa | Qué hacer |
   |---|---|---|
   | `vpc_invalido` | el nombre no es un nombre de GCP (mayúsculas, espacios, `_`) | corregir el nombre en las asignaciones, o fijarlo en un ajuste |
   | `sin_proyecto` / `vpc_incoherente` | la VPC no tiene proyecto o aparece con varios | indicar el proyecto correcto en un ajuste |
   | `bloques_solapados` / `bloque_con_ajenas` | el bloque calculado pisa a otra VPC o a asignaciones sin VPC | fijar el bloque (`cidr`) en un ajuste, más amplio o más preciso |
   | `reserva_vigente_en_bloque` | hay reservas vigentes dentro del bloque | confirmarlas, liberarlas o esperar a que expiren |
   | `bloque_igual_al_padre` / `bloque_invalido` | el bloque no es más chico que el padre o no está alineado | fijar el bloque en un ajuste |

   Los `avisos` (p. ej. asignaciones sin VPC, que se quedan en el padre) no impiden aplicar.
3. **Ajustes** (solo si hay problemas): un archivo JSON con una entrada por VPC, todas las claves opcionales salvo `vpc`:
   ```json
   [{ "vpc": "vpc-hub", "proyecto": "hub-uno", "cidr": "10.200.0.0/20", "id": "vpc-hub-dev" }]
   ```
   Se pasa con `--ajustes ajustes.json`. Repite la simulación hasta que `problemas` quede vacío (`"ok": true`).
4. **Aplicar** (todo o nada; vuelve a calcular el plan sobre el estado de ese momento):
   ```bash
   npm run migrar-vpc -- --pool dev-gcp-ccla --ajustes ajustes.json --aplicar
   ```
   Crea los pools hijos (tipo `VPC`, con los límites de máscara del padre que caben), mueve las asignaciones, hace que las IP fijas sigan a su segmento y deja una fila de auditoría `crear_pool` por VPC (usuario `migracion-vpc`). Si algo falla, no se cambia nada.
5. **Comprobar:** `GET /api/v1/pools` muestra los hijos y el padre con más `uso` (cuenta lo repartido); `GET /api/v1/pools/dev-gcp-ccla/disponibilidad` descuenta los bloques; y un `POST /reservas/lote?simular=true` con `vpc` y `proyecto` elige el pool de la VPC.

## Qué NO cambia
- El texto `vpc` de cada asignación se conserva tal cual (la migración no lo renombra); el pool nuevo usa el nombre normalizado.
- Las asignaciones sin nombre de VPC se quedan en el padre.
- Los clientes actuales no cambian: sin `vpc` o con `EXIGIR_POOL_VPC` apagada, el lote sigue usando `pool-uso`. Cuando todas las VPC tengan su pool, un admin puede activar `EXIGIR_POOL_VPC=dev`.

## Reversión
Dentro de la ventana y con el respaldo a mano, por cada pool hijo (como dueño de las tablas): primero se suelta del padre, luego se devuelven sus asignaciones y por último se borra.
```sql
begin;
update pools set padre_id = null where id = '<hijo>';
update asignaciones set pool_id = 'dev-gcp-ccla' where pool_id = '<hijo>';
update direcciones_ip set asignacion_id = asignacion_id where asignacion_id in (select id from asignaciones where pool_id = 'dev-gcp-ccla');
delete from pools where id = '<hijo>';
commit;
```
Si ya hubo reservas o subredes nuevas en el hijo, revisa antes qué se mueve.
