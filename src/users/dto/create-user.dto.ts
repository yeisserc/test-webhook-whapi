export class CreateUserDto {
  email!: string;
  password!: string;
  phoneNumber?: string;
  bankUsername?: string;
  bankPassword?: string;
  companyName?: string;
  paymentDocument?: string;
  paymentPhoneNumber?: string;
  paymentBank?: string;
}
