export class CreateUserDto {
  email!: string;
  password!: string;
  phoneNumber?: string;
  bankUsername?: string;
  bankPassword?: string;
}
