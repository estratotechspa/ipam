# Runbook (qué hacer cuando algo falla)

Cada fila: síntoma → causa probable → acción. Los logs son JSON con `request_id`; las alertas están en [OBSERVABILIDAD](OBSERVABILIDAD.md). Mira siempre `GET /healthz` (vivo) y `GET /readyz` (listo) primero.

## Diagnóstico rápido
```bash
curl -s $IPAM_URL/healthz ; curl -s $IPAM_URL/readyz
# Kubernetes:  kubectl -n ipam logs deploy/ipam --tail=100      Render: panel → Logs
```

| Síntoma | Causa probable | Acción |
|---|---|---|
| `/readyz` responde 503 | Base inaccesible o esquema sin migrar | Revisa `DATABASE_URL`, red y que `npm run migrar` corrió; mira `esquema.version` vs `minima` |
| El servicio **no arranca** en producción | Sin autenticación configurada, o variable inválida | Lee el mensaje de arranque (dice qué falta); configura OIDC, Basic o un token ([ACCESO-Y-SEGURIDAD](../ACCESO-Y-SEGURIDAD.md)) |
| Muchos 401 | Token vencido/revocado, o credenciales erróneas | Crea otro token; revisa que el pipeline envía `Authorization: Bearer` |
| 429 | Límite de peticiones o cuota de reservas | Espera `Retry-After`; baja la frecuencia del agente; libera reservas viejas; sube los límites solo si es legítimo |
| 409 al reservar | Rango ocupado, o clave ya usada y liberada/expirada | Pide otro rango o una `Idempotency-Key` nueva |
| Reservas «colgadas» | El pipeline murió sin liberar | Esperan su expiración (≤ 72 h) o libéralas en la pestaña Reservas |
| El barredor no corre (alerta) | Réplica `worker` caída o base sin conexión | Revisa que haya una réplica con `ROL=todos` o `worker`; el estado está en `barredor_estado` |
| Un pool lleno (≥ 90 %) | Crecimiento | Agrega otro pool/rango ([MIGRACION](MIGRACION.md) para cargar pools) o libera lo que ya no se use |
| POC lento la primera vez | Plan gratuito dormido | Espera ~90 s; opcional: keepalive ([POC](POC-RENDER-SUPABASE.md)) |
| Error de conexión a Supabase | Puerto 6543 o usuario sin `.<ref>` | Usa el pooler en modo sesión (5432) y `ipam_app.<ref>` |
| `permission denied` en la base | Permisos de `ipam_app` sin aplicar | Re-ejecuta la migración (repite los `grant`) |

## Si un secreto se filtró
1. **Token de servicio:** revócalo en la interfaz y crea otro.
2. **Contraseña de un rol de base:** `alter role ipam_app password '<NUEVA>'` y actualiza el secreto de la plataforma; reinicia.
3. **`SESSION_SECRET`:** cámbialo (todas las sesiones se cierran).
4. **Secreto del webhook de Jira / cliente OIDC:** rótalo en el proveedor y en el IPAM.
5. Revisa la auditoría desde la fecha de la filtración.

## Escalar o dividir
`ROL=api` para réplicas HTTP y una réplica `ROL=worker` para el barredor; sube `DB_POOL_MAX` con cuidado (suma por réplica ≤ conexiones de la base).

## Recuperar la base
Ver [RESPALDO-Y-RECUPERACION](RESPALDO-Y-RECUPERACION.md).
