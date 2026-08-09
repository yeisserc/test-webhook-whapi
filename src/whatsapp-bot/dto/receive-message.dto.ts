export class ReceiveMessageDto {
  phoneNumber!: string;
  message?: string;
  mediaUrl?: string; // URL de la imagen/screenshot
  mediaType?: string; // 'image', 'document', etc.
  messageId?: string;
}
