export class ProcessPaymentDto {
  collectionSendId!: string;
  referenceNumber?: string;
  screenshotUrl?: string;
  amount!: number;
  installmentNumber!: number;
}
