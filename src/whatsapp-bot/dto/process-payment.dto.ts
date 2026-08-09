export class ProcessPaymentDto {
  collectionId!: string;
  referenceNumber?: string;
  screenshotUrl?: string;
  amount!: number;
  installmentNumber!: number;
}
