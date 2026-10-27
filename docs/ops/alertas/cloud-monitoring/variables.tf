variable "proyecto" {
  description = "Proyecto de Google Cloud donde viven las alertas."
  type        = string
}

variable "canales_de_notificacion" {
  description = "IDs completos de canales de notificación de Cloud Monitoring (correo, Slack, PagerDuty…). Vacío = las alertas se crean sin avisar a nadie."
  type        = list(string)
  default     = []
}
