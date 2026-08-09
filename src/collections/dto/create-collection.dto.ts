export class CreateCollectionDto {
  userId!: string;
  clientId!: string;
  totalDebt!: number;
  installments!: number;
  frequency!: string;
  collectionDay?: string;
  concept!: string;
}
