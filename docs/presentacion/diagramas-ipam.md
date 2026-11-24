# IPAM: diagramas de arquitectura

Documento para el equipo de arquitectura, redes y plataforma. Describe el IPAM versión `0.6.0` y la arquitectura propuesta para llevarlo a Google Cloud (GCP).

**Cómo leerlo**

| Marca | Significado |
|---|---|
| Línea continua | Existe en el código, o es parte del despliegue propuesto para el primer paso a GCP |
| Línea punteada, borde punteado | Planificado para el siguiente sprint (agente de IA), o apagado por defecto (Jira) |

El IPAM corre hoy solo en un equipo local. **El diagrama 1 es una propuesta**: nada de él está desplegado todavía.

## 1. Despliegue y arquitectura en GCP (propuesta)

```mermaid
flowchart TB
  subgraph EXT["Sistemas externos"]
    direction LR
    PER["Solicitante y<br/>admin de redes"]
    XLS["Excel actual<br/>de redes"]
    JIRA["Jira<br/>(módulo apagado)"]
  end

  subgraph AG["Agente de IA · siguiente sprint"]
    direction LR
    ZAF["Zafiro<br/>orquestador"]
    MCP["Servidor MCP<br/>del IPAM"]
    ZAF -.->|"MCP"| MCP
  end

  subgraph GL["GitLab corporativo"]
    direction LR
    CI["Repositorio IPAM<br/>y pipeline CI/CD"]
    IAC["Repositorio OpenTofu<br/>y pipeline de redes"]
  end

  subgraph GCP["Proyecto GCP del IPAM · propuesto"]
    subgraph VIN["VPC corporativa · entrada privada"]
      ILB["Balanceador interno<br/>de aplicaciones"]
    end
    subgraph RUN["Cómputo · Cloud Run"]
      direction LR
      SVC["Servicio ipam<br/>Node 22, puerto 8080<br/>SA: ipam-run"]
      JOB["Job ipam-migrar<br/>aplica el esquema<br/>SA: ipam-migrar"]
    end
    subgraph VOUT["VPC corporativa · salida a datos"]
      SUB["Subred de egreso<br/>Direct VPC"]
      PSA["Acceso privado a<br/>servicios (peering)"]
    end
    subgraph PLA["Servicios administrados"]
      direction LR
      SQL[("Cloud SQL<br/>PostgreSQL 16<br/>solo IP privada")]
      SEC["Secret Manager"]
      AR["Artifact Registry"]
      OBS["Cloud Logging y<br/>Cloud Monitoring"]
    end
  end

  IDP["Proveedor de identidad<br/>corporativo (OIDC)"]
  DST["Proyectos GCP destino<br/>VPC, subnet, SA default<br/>con networkUser"]

  PER -->|"HTTPS"| ILB
  XLS -->|"HTTPS / REST, XLSX"| ILB
  JIRA -.->|"HTTPS, webhook HMAC"| ILB
  MCP -.->|"HTTPS / REST, Bearer"| ILB
  ZAF -.->|"HTTPS / Git, MR"| IAC
  IAC -.->|"OpenTofu / API GCP"| DST
  CI -->|"HTTPS / API GCP, identidad federada"| JOB
  CI -->|"HTTPS / API GCP, identidad federada"| SVC
  CI -->|"HTTPS / OCI, imagen"| AR
  ILB -->|"HTTPS, NEG serverless"| SVC
  SVC -->|"TCP 5432"| SUB
  JOB -->|"TCP 5432"| SUB
  SUB --> PSA
  PSA -->|"SQL / TCP 5432, TLS"| SQL
  SVC -->|"HTTPS / API"| SEC
  JOB -->|"HTTPS / API"| SEC
  SVC -->|"JSON por stdout"| OBS
  SVC -->|"HTTPS / OIDC"| IDP

  classDef plan stroke-dasharray: 5 5
  class ZAF,MCP,DST,IAC,JIRA plan
```

**Decisiones de diseño**

1. **Cloud Run antes que GKE.** Es un solo contenedor sin estado y con poca carga. Un clúster agrega operación sin aportar nada a este volumen.
2. **Sin entrada desde Internet.** El ingreso de Cloud Run acepta solo tráfico interno y del balanceador.
3. **Dos identidades.** La que atiende peticiones no puede cambiar el esquema. La que migra no atiende peticiones.
4. **Base solo con IP privada, por TCP 5432.** La documentación de Google describe la conexión por IP privada como TCP directo; el socket `/cloudsql` aparece bajo la ruta de IP pública. El ejemplo OpenTofu del repositorio usa el socket con una base solo privada, por lo que **hay que probarlo o cambiarlo antes de desplegar**.
5. **Sin llaves de larga duración.** GitLab se autentica en GCP con Workload Identity Federation.
6. **Sin Firestore, Cloud Storage ni Cloud Scheduler.** El Excel se procesa en memoria y la limpieza de reservas vencidas corre dentro del servicio. Si se guardan respaldos lógicos fuera de Cloud SQL, ahí sí se suma un bucket.

Se distingue el **acceso al IPAM** (arriba) del **pipeline de infraestructura**: el IPAM nunca crea redes. Solo aparta y registra rangos; OpenTofu crea la VPC y la subnet en los proyectos destino.

## 2. Contenedores y componentes (C4, niveles 2 y 3)

```mermaid
flowchart LR
  subgraph ACT["Actores"]
    direction TB
    U["Persona<br/>navegador"]
    A["Agente o pipeline"]
    J["Jira"]
  end

  subgraph APP["Contenedor IPAM · Node 22 + Express 5"]
    direction LR
    subgraph ENT["Adaptadores de entrada"]
      direction TB
      WEB["Interfaz web<br/>HTML y módulos JS"]
      SEG["Acceso y límites<br/>OIDC, local, token"]
      API["API REST /api/v1<br/>valida con OpenAPI 3.1"]
      XIN["Lector XLSX y CSV"]
      HOOK["Webhook Jira<br/>apagado por defecto"]
      BAR["Barredor<br/>tarea periódica"]
    end
    subgraph CU["Aplicación · casos de uso"]
      direction TB
      RES["Reservas y<br/>reservas en grupo"]
      ASI["Asignaciones<br/>y pools"]
      IMP["Importación<br/>y respaldo"]
      ADM["Tokens, usuarios<br/>y auditoría"]
      TIC["Tickets Jira"]
      BRR["Barrido"]
    end
    subgraph DOM["Dominio · reglas puras"]
      direction TB
      CID["Cálculo CIDR<br/>libres y solapes"]
      CIC["Ciclo de reserva<br/>estados y vigencia"]
      ROL["Roles y alcance"]
      REC["Reconciliación<br/>nube contra IPAM"]
    end
    subgraph SAL["Adaptadores de salida"]
      direction TB
      PER["Repositorio<br/>PostgreSQL"]
      EVE["Eventos<br/>tabla, log, webhook"]
      XOUT["Exportador XLSX"]
      MET["Métricas y trazas"]
      JOUT["Cliente Jira<br/>apagado por defecto"]
    end
  end

  DB[("PostgreSQL<br/>restricción anti-solape")]
  OBS["Prometheus y<br/>OpenTelemetry"]
  DES["Receptor de eventos"]

  U -->|"HTTPS"| WEB
  WEB -->|"fetch / JSON"| SEG
  A -->|"HTTPS / REST, Bearer"| SEG
  J -.->|"HTTPS, HMAC-SHA256"| HOOK
  SEG --> API
  API -->|"base64"| XIN
  API --> RES
  API --> ASI
  API --> ADM
  XIN --> IMP
  HOOK -.-> TIC
  TIC -.-> RES
  BAR --> BRR
  API -->|"POST /reconciliacion"| REC
  RES --> CID
  RES --> CIC
  ASI --> CID
  IMP --> CID
  ADM --> ROL
  RES -->|"puerto Repositorio"| PER
  ASI --> PER
  IMP --> PER
  ADM --> PER
  BRR --> PER
  RES -->|"puerto Eventos"| EVE
  TIC -.-> JOUT
  ADM -->|"por lotes"| XOUT
  API --> MET
  PER -->|"SQL / TCP 5432"| DB
  XOUT -->|"stream XLSX"| U
  EVE -->|"HTTPS, HMAC"| DES
  MET -->|"HTTP /metrics, OTLP"| OBS
  JOUT -.->|"HTTPS / REST"| J

  classDef plan stroke-dasharray: 5 5
  class HOOK,TIC,JOUT,J plan
```

La arquitectura es **hexagonal**: el dominio no conoce la base de datos ni la red. Las flechas simplifican las dependencias; los casos de uso llegan a los adaptadores de salida por puertos, y `server.js` los conecta al arrancar. Una prueba automática impide que el núcleo importe el SDK de una nube.

## 3. Secuencia de extremo a extremo

El disparador es HTTP: una persona en la interfaz, o un agente por la API. No hay Cloud Scheduler.

```mermaid
sequenceDiagram
  autonumber
  actor S as Solicitante o agente
  actor R as Admin de redes
  participant W as Interfaz y API
  participant C as Casos de uso
  participant D as Dominio
  participant P as PostgreSQL

  rect rgb(241, 245, 249)
    Note over R,P: A. Carga inicial desde Excel (una vez)
    R->>W: HTTPS POST /importaciones/simular (XLSX en base64)
    W->>C: filas leídas (máx. 5.000)
    C->>P: SQL: pools y rangos ocupados
    C->>D: validar CIDR y solapes
    D-->>C: válidas, inválidas y solapadas
    C-->>R: informe, sin escribir nada
    R->>W: HTTPS POST /importaciones/aplicar
    W->>C: importar filas válidas
    C->>P: SQL: transacción todo o nada
    P-->>C: confirmada
    C-->>R: segmentos importados
  end

  rect rgb(236, 253, 245)
    Note over S,P: B. Reserva automática
    S->>W: HTTPS POST /reservas (ambiente, tipo, máscara)
    W->>W: sesión o token, rol, límite y esquema
    W->>C: reservar (Idempotency-Key opcional)
    C->>P: SQL: bloqueo del pool y rangos ocupados
    C->>D: buscar bloque libre
    D-->>C: CIDR propuesto, o ninguno
    alt hay espacio
      C->>P: SQL: INSERT de la reserva
      P-->>C: creada, sin solapes
      C-->>S: 201, CIDR apartado por 72 h
    else sin espacio o rango solapado
      C-->>S: 409, motivo
    end
  end

  rect rgb(255, 251, 235)
    Note over S,P: C. Aprobación humana
    alt admin aprueba
      R->>W: HTTPS POST /reservas/{id}/confirmar
      W->>C: confirmar (solo rol admin)
      C->>P: SQL: crea asignación y marca confirmada
      C-->>R: 200, asignación definitiva
      S->>W: HTTPS GET /reservas/{id}
      W-->>S: estado confirmada
    else se rechaza
      R->>W: HTTPS DELETE /reservas/{id}
      W->>C: liberar (dueño o admin)
      C->>P: SQL: marca liberada
    else nadie responde
      Note over C,P: Vence la vigencia y el rango vuelve a estar libre
    end
  end

  rect rgb(241, 245, 249)
    Note over R,P: D. Exportación y auditoría
    R->>W: HTTPS GET /exportar.xlsx (módulo excel activo)
    W->>P: SQL: lectura por lotes
    W-->>R: stream XLSX
    W->>P: SQL: auditoría de solo inserción
  end
```

Todas las rutas cuelgan de `/api/v1`. Para una **VPC nueva** el flujo B y C se recorre dos veces: primero el bloque de la VPC y, una vez aprobado, sus subnets (`POST /reservas/lote`).

## 4. Componentes identificados

| Componente | Tecnología / servicio GCP | Responsabilidad | Estado |
|---|---|---|---|
| Servicio IPAM | Cloud Run, Node 22, Express 5 | Interfaz, API y reglas | Código listo, despliegue por hacer |
| Migrador | Cloud Run Job | Aplica el esquema antes de cada versión | Código listo, despliegue por hacer |
| Base de datos | Cloud SQL, PostgreSQL 16 | Datos, anti-solape y auditoría | Propuesto |
| Secretos | Secret Manager | Conexión, sesión, OIDC y métricas | Propuesto |
| Identidades | Cloud IAM (2 cuentas de servicio) | Mínimo privilegio | Propuesto |
| Imagen | Artifact Registry | Guarda la imagen versionada | Propuesto |
| Entrada | Balanceador interno de aplicaciones | Acceso privado a la interfaz y API | Propuesto, no está en el ejemplo OpenTofu |
| Red | Direct VPC egress y acceso privado a servicios | Camino privado a la base | Propuesto |
| Observabilidad | Cloud Logging y Cloud Monitoring | Logs, tablero y alertas | Logs listos; métricas requieren recolector |
| CI/CD | GitLab y Workload Identity Federation | Pruebas, imagen y despliegue | `.gitlab-ci.yml` existe, sin ejecutar en GitLab real |
| Identidad de personas | OIDC corporativo | Inicio de sesión y roles | Código existe, **botón apagado** |
| Servidor MCP del IPAM | Por definir | Expone la API como herramientas del agente | **No existe, siguiente sprint** |
| Agente de IA y Zafiro | Desarrollo interno | Orquesta la solicitud y prepara el MR | **Siguiente sprint** |
| Infraestructura destino | OpenTofu, VPC, subnet, IAM | Crea la red con el CIDR aprobado | **Siguiente sprint** |

## 5. Supuestos y dependencias por confirmar

### Bloqueantes antes de desplegar

Se encontraron al revisar el código. No se modificó nada.

| # | Hallazgo | Evidencia | Acción |
|---|---|---|---|
| 1 | **Acceso `admin`/`admin`** si falta `APP_PASS`, también en producción con OIDC. Se probó en local: respondió 200 con sesión | `mvp/src/adaptadores/auth/emergencia.js` | Quitar la clave por defecto y fallar al arrancar |
| 2 | **Clave fija para firmar sesiones** si falta `SESSION_SECRET`. Solo OIDC la exige, y los ejemplos de Cloud Run no la definen | `mvp/src/adaptadores/auth/sesion.js` | Exigirla siempre en producción |
| 3 | **SSO oculto:** `/auth/opciones` responde siempre `sso: false` | `mvp/src/adaptadores/auth/emergencia.js` | Reactivar con el OIDC corporativo |
| 4 | **El pipeline de ejemplo fallaría:** su paso `confirmar-ipam` usa token de agente, pero confirmar exige rol admin (403). Además va después de `apply` | `docs/ops/gitlab/.gitlab-ci.yml` | Reemplazar por esperar la aprobación antes de `apply` |
| 5 | **Socket de Cloud SQL con base solo privada**, sin probar | `despliegue/ejemplos-iac/gcp/main.tf` | Usar TCP a la IP privada |

### Por confirmar

| # | Supuesto | Quién confirma |
|---|---|---|
| 1 | Proyecto GCP, región y VPC donde vivirá el IPAM | Plataforma y redes |
| 2 | Si se usa Shared VPC. De ello depende `roles/compute.networkUser` en la subnet | Redes |
| 3 | **Qué cuenta es la «SA default»:** la de Compute Engine o la de APIs de Google (`NUMERO@cloudservices.gserviceaccount.com`) | Redes y seguridad |
| 4 | Que el rol se otorgue por subnet y no a todo el proyecto host. Lo otorga un administrador de Shared VPC | Seguridad |
| 5 | Proveedor OIDC corporativo y grupos para cada rol | Seguridad |
| 6 | Conectividad desde GitLab, Zafiro y usuarios hasta el balanceador interno, con DNS y certificado | Redes |
| 7 | Calidad del Excel actual: duplicados, solapes y dueños vigentes | Redes |
| 8 | Rangos base y tamaños por ambiente. El IPAM no permite repetir un rango entre pools independientes | Redes |
| 9 | Si Jira se reactiva. La salida hacia Jira no se ha probado con un Jira real | Dueño de Jira |
| 10 | Contrato del servidor MCP, identidad del agente y custodia de su token | Equipo del agente |
| 11 | Respaldo, retención y tiempos de recuperación de Cloud SQL | Plataforma |
| 12 | Doble aprobación: en el IPAM (el rango) y en el MR (el cambio) | Redes y arquitectura |

**Fuera de alcance del IPAM:** IPv6, descubrimiento automático de redes existentes, reglas hacia on-premise y firewalls.

**Referencias:** [Cloud Run con Cloud SQL](https://docs.cloud.google.com/sql/docs/postgres/connect-run), [Shared VPC](https://docs.cloud.google.com/vpc/docs/provisioning-shared-vpc), [balanceador interno con Cloud Run](https://docs.cloud.google.com/load-balancing/docs/l7-internal/setting-up-l7-internal-serverless), [rangos internos de GCP](https://docs.cloud.google.com/vpc/docs/internal-ranges).
