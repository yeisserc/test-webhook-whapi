export class SendReminderDto {
  collectionId!: string;
  daysUntilPayment!: number; // 2 o 0 para el día de cobro
  phoneNumber!: string;
}
