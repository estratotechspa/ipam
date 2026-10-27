# Glosario

Términos en orden alfabético, explicados sin jerga. El término en inglés va entre paréntesis la primera vez que aparece.

| Término | Qué significa |
|---|---|
| **Adaptador** (*adapter*) | Pieza que conecta el núcleo del IPAM con algo externo: la base de datos, el login, el límite de peticiones. Se puede cambiar sin tocar las reglas de negocio. |
| **Agente** | Programa o pipeline que usa la API con un token. Puede reservar, pero no asignar directo ni administrar. También es un rol. |
| **Ambiente** | `dev`, `qa`, `pre` o `prod`: la etapa de un proyecto. Cada pool pertenece a uno. |
| **Asignación** | Segmento entregado de forma definitiva a un proyecto. Nadie más puede tomarlo hasta que se libere. |
| **Auditoría** | Bitácora de solo inserción: quién hizo qué y cuándo. No se puede editar ni borrar. |
| **Barredor** (*sweeper*) | Tarea de fondo que marca como `expirada` las reservas vencidas. La corrección no depende de él (ver «expiración perezosa»). |
| **Basic** | Acceso con usuario y contraseña. Solo para POC y demos. |
| **Bearer** | Forma de enviar un token en la cabecera `Authorization: Bearer ipam_…`. |
| **CIDR** | Forma de escribir un rango de IP: `10.210.0.0/22` significa «desde 10.210.0.0, 1.024 direcciones». Cuanto más pequeño el número tras `/`, más grande el rango. |
| **Confirmar** | Pasar una reserva a asignación definitiva. Un agente debe indicar quién aprobó y dónde consta. |
| **Cuota** | Tope de reservas vigentes que puede tener un token. |
| **Expiración perezosa** (*lazy expiry*) | Una reserva vencida se trata como vencida en el momento de consultarla, aunque el barredor aún no la haya marcado. |
| **GKE / Cloud Run / Cloud SQL** | Servicios de Google Cloud: Kubernetes administrado, contenedores sin servidor y PostgreSQL administrado. |
| **Hexagonal (arquitectura)** | Diseño en que el núcleo no conoce los detalles externos; habla con ellos por «puertos». Es lo que permite cambiar de nube sin reescribir. |
| **Human-in-the-loop** | «Humano en el circuito»: un cambio automático no se vuelve definitivo sin la aprobación de una persona. |
| **Idempotencia** (*idempotency*) | Repetir la misma petición no duplica el efecto. Se logra con la cabecera `Idempotency-Key`. |
| **IPAM** | *IP Address Management*: gestión de direcciones IP. |
| **Lector** | Rol de solo lectura. |
| **Liberar** | Devolver un rango al pool (una reserva o una asignación). |
| **Migración** | Aplicar los cambios de estructura de la base de datos (`npm run migrar`). Es un paso aparte del arranque. |
| **OIDC** | *OpenID Connect*: inicio de sesión corporativo (SSO) con un proveedor de identidad. |
| **OpenAPI** | Descripción formal de la API (`/api/v1/openapi.json`). Sirve para generar clientes y probar. |
| **OpenTofu** (`tofu`) | Herramienta de infraestructura como código, compatible con Terraform. Los ejemplos usan `tofu`; `terraform` también sirve. |
| **Pool** | **Bloque grande** (p. ej. `10.210.0.0/20`) definido para un tipo de uso en un ambiente; de él se cortan las asignaciones. «Pool» es el término habitual en IPAM: una reserva común de la que se van sacando rangos. No es lo mismo que una asignación (un pedazo ya entregado). |
| **Pooler** | Intermediario de conexiones delante de PostgreSQL (el de Supabase). El IPAM necesita el modo **sesión**. |
| **Prometheus / `/metrics`** | Sistema de métricas y la ruta que las publica. Nace cerrada. |
| **Rate limit** | Límite de peticiones por minuto para evitar abusos. Responde 429 al pasarse. |
| **Reserva** (*reservation*) | Rango apartado de forma tentativa. Expira sola (24 h por defecto, 72 h máximo) si nadie la confirma. |
| **RLS** | *Row Level Security*: seguridad por filas de PostgreSQL. Se usa como defensa extra en Supabase. |
| **Rol** | Nivel de permisos: `lector < agente < solicitante < admin`. |
| **Secondary ranges** (rangos secundarios) | En GCP, rangos adicionales de una subred que usan los Pods y Servicios de GKE. Ver [CONTRATO-YAML-REDES](CONTRATO-YAML-REDES.md). |
| **Segmento** | Un CIDR concreto dentro de un pool. |
| **Solicitante** | Rol que puede pedir segmentos directamente. |
| **SBOM** | Lista de ingredientes (dependencias) del software. |
| **SSRF** | Ataque que hace que el servidor llame a direcciones internas. El webhook saliente está protegido. |
| **TTL** | *Time To Live*: cuánto dura una reserva antes de expirar. |
| **Token de servicio** | Credencial de un agente. Empieza con `ipam_`; solo se guarda su huella (hash), nunca el valor. |
| **Webhook** | Aviso HTTP que un sistema envía a otro cuando ocurre algo (p. ej. Jira → IPAM). |
| **12-factor** | Conjunto de prácticas para apps portables: configuración por variables de entorno, logs a la salida estándar, procesos sin estado. |
