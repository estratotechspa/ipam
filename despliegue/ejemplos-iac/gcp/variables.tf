variable "proyecto" {
  description = "ID del proyecto de Google Cloud donde se crea todo."
  type        = string
}

variable "region" {
  description = "Región de Cloud Run y Cloud SQL."
  type        = string
  default     = "us-central1"
}

variable "imagen" {
  description = "Imagen del IPAM (registro configurable: Artifact Registry, GHCR, GitLab Registry…). Ejemplo: us-central1-docker.pkg.dev/PROYECTO/ipam/ipam:0.3.0"
  type        = string
}

variable "ambiente" {
  description = "Ambiente: dev, qa, pre o prod. Entra en los nombres de los recursos."
  type        = string
  default     = "dev"
  validation {
    condition     = contains(["dev", "qa", "pre", "prod"], var.ambiente)
    error_message = "El ambiente debe ser dev, qa, pre o prod."
  }
}

variable "url_publica" {
  description = "URL pública con la que los usuarios abren el IPAM (base del login OIDC)."
  type        = string
}

variable "usuario_basic" {
  description = "Usuario del modo Basic (POC). Vacío = no se configura Basic (usa OIDC). Si lo defines, define también clave_basic_hash."
  type        = string
  default     = ""
}

variable "clave_basic_hash" {
  description = "Hash scrypt de la clave Basic (npm run hash-password). Nunca la clave en texto plano."
  type        = string
  default     = ""
  sensitive   = true
}

variable "red_privada" {
  description = "Red de VPC (self_link) para la IP privada de Cloud SQL. Vacío = IP pública con autorización solo por socket."
  type        = string
  default     = ""
}

variable "proteger_borrado" {
  description = "Protege la base contra borrado accidental. Déjalo en true salvo en ambientes desechables."
  type        = bool
  default     = true
}
