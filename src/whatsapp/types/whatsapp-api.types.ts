export type WhatsAppTemplateComponent = {
  type: 'header' | 'body' | 'button';
  sub_type?: 'quick_reply' | 'url';
  index?: string;
  parameters: WhatsAppTemplateParameter[];
};

export type WhatsAppTextParameter = {
  type: 'text';
  text: string;
  parameter_name?: string;
};

export type WhatsAppTemplateParameter =
  | WhatsAppTextParameter
  | { type: 'currency'; currency: { fallback_value: string; code: string; amount_1000: number } }
  | { type: 'date_time'; date_time: { fallback_value: string } };

export type WhatsAppSendMessageResponse = {
  messaging_product: string;
  contacts: Array<{ input: string; wa_id: string }>;
  messages: Array<{ id: string; message_status?: string }>;
};

export type WhatsAppApiError = {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
};
