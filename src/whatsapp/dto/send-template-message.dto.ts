/** Parametros posicionales ({{1}}, {{2}}...) o con nombre ({ name, value }) */
export type TemplateParameterInput = string | { name: string; value: string };

export class SendTemplateMessageDto {
  /** Numero destino con codigo de pais (ej. 584121234567) */
  to!: string;

  /** Nombre del template aprobado en Meta Business */
  templateName!: string;

  /** Codigo de idioma del template (ej. es, es_MX, en_US) */
  languageCode?: string;

  /**
   * Parametros del cuerpo del template.
   * - string[]: posicionales ({{1}}, {{2}}...)
   * - Record: con nombre ({ cliente: 'Juan', monto: '150' })
   * - { name, value }[]: con nombre en array
   */
  bodyParameters?: TemplateParameterInput[] | Record<string, string>;

  /**
   * Parametros del encabezado del template.
   * Mismos formatos que bodyParameters.
   */
  headerParameters?: TemplateParameterInput[] | Record<string, string>;
}
