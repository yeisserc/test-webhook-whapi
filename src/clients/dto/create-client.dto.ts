export class CreateClientDto {
  userId!: string;
  firstName!: string;
  lastName!: string;
  nickname?: string;
  countryCode?: string;
  phoneCode!: string;
  phoneNumber!: string;
}
