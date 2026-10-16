export class MetaWebhookPayload {
  object?: string;
  entry?: MetaWebhookEntry[];
}

export type MetaWebhookEntry = {
  id?: string;
  changes?: MetaWebhookChange[];
};

export type MetaWebhookChange = {
  field?: string;
  value?: MetaWebhookValue;
};

export type MetaWebhookValue = {
  messaging_product?: string;
  metadata?: {
    display_phone_number?: string;
    phone_number_id?: string;
  };
  contacts?: Array<{
    profile?: { name?: string };
    wa_id?: string;
  }>;
  messages?: MetaWebhookMessage[];
  statuses?: MetaWebhookStatus[];
};

export type MetaWebhookStatus = {
  id?: string;
  status?: string;
  timestamp?: string;
  recipient_id?: string;
  errors?: Array<{
    code?: number;
    title?: string;
    message?: string;
    error_data?: { details?: string };
  }>;
};

export type MetaWebhookMessage = {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: {
    body?: string;
  };
  image?: {
    id?: string;
    mime_type?: string;
    sha256?: string;
    caption?: string;
  };
  document?: {
    id?: string;
    mime_type?: string;
    sha256?: string;
    caption?: string;
    filename?: string;
  };
};
