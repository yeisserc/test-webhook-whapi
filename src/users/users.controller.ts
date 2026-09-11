import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { createUuidPipe } from '../common/uuid.pipe';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { LoginUserDto } from './dto/login-user.dto';
import { RegisterUserDto } from './dto/register-user.dto';
import { UpdateBankAccountDto } from './dto/update-bank-account.dto';
import type { UpdateUserDto } from './dto/update-user.dto';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  findAll() {
    return this.usersService.findAll();
  }

  @Post('register')
  register(@Body() payload: RegisterUserDto) {
    return this.usersService.register(payload);
  }

  @Post('login')
  login(@Body() payload: LoginUserDto) {
    return this.usersService.login(payload);
  }

  @Get(':id')
  findOne(@Param('id', createUuidPipe()) id: string) {
    return this.usersService.findOne(id);
  }

  @Post()
  create(@Body() payload: CreateUserDto) {
    return this.usersService.create(payload);
  }

  @Patch(':id/bank-account')
  updateBankAccount(
    @Param('id', createUuidPipe()) id: string,
    @Body() payload: UpdateBankAccountDto,
  ) {
    return this.usersService.updateBankAccount(id, payload);
  }

  @Patch(':id')
  update(
    @Param('id', createUuidPipe()) id: string,
    @Body() payload: UpdateUserDto,
  ) {
    return this.usersService.update(id, payload);
  }

  @Delete(':id')
  remove(@Param('id', createUuidPipe()) id: string) {
    return this.usersService.remove(id);
  }
}
