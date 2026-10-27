# ADR 0002 · Tokens de servicio con rol `agente`

- **Estado:** aceptada · **Fecha:** 2026-10-21

## Contexto
Los agentes (hoy scripts de Python locales; mañana una plataforma central) necesitan llamar a la API sin una persona delante. El login corporativo (OIDC) es para personas:
exige navegador, redirecciones y cookies.

## Decisión
**Tokens de servicio** con estas reglas:
- Formato `ipam_` + 43 caracteres base64url (256 bits de un generador criptográfico). Se muestra **una sola vez**; en la base solo vive el **hash SHA-256**.
  Un secreto de 256 bits no necesita un hash «lento»: no se puede adivinar por fuerza bruta.
- Roles: `lector` < `agente` < `solicitante` < `admin`. Los tokens solo pueden ser `lector` o `agente`. El `agente` reserva, confirma y libera **sus propias reservas**,
  pero no asigna directo ni administra usuarios ni tokens.
- Vigencia de 1 a 365 días (90 por defecto) y revocables al instante.
- `Authorization: Bearer …` se evalúa **primero**, en cualquier modo de autenticación. Un token inválido es 401 aunque el servicio esté en modo abierto.
- Sin `X-Requested-With`: la defensa CSRF existe porque el navegador adjunta cookies solas; un token no es una cookie. Las escrituras por cookie o Basic siguen exigiéndola.
- Cada uso se audita como `svc:<nombre>`; los rechazos como `token_rechazado` (sin el token). `ultimo_uso` se actualiza como máximo una vez por minuto.
- Se administran solo con un admin (`POST/GET/DELETE /api/tokens`). **Rotar:** crear uno nuevo con otro nombre, actualizar el agente, revocar el viejo.

## Alternativas
- **Reutilizar el usuario Basic:** un solo secreto compartido, rol admin, sin vencimiento ni revocación individual. Descartado.
- **OIDC client credentials / identidad de carga de trabajo (Workload Identity):** es lo ideal cuando el agente corra en una nube que lo soporte. Queda como evolución: el IPAM ya
  acepta cualquier emisor OIDC, y un adaptador nuevo en `adaptadores/auth/` podría aceptar tokens firmados por el emisor sin tocar el dominio.
- **mTLS:** más fuerte pero mucho más pesado de operar para un POC.

## Consecuencias
- (+) Credenciales con nombre, rol mínimo, vencimiento y revocación; auditables.
- (−) Un token robado sirve hasta que se revoque o venza: por eso los roles son mínimos, la cuota por token acota el daño y el [runbook](../ops/RUNBOOK.md) explica cómo revocar y rotar.
