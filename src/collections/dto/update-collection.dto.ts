export class UpdateCollectionDto {
	userId?: string;
	clientId?: string;
	totalDebt?: number;
	currentDebt?: number;
	installments?: number;
	currentInstallment?: number;
	frequency?: string;
	collectionDay?: string;
	concept?: string;
}
