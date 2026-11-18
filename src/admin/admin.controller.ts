import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { createUuidPipe } from '../common/uuid.pipe';
import { AdminAuthService } from './admin-auth.service';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';

type AdminLoginBody = {
  email?: string;
  password?: string;
};

type UpdateCompanyBody = {
  isActive?: boolean;
};

type CreateRateBody = {
  currency?: string;
  rate?: number;
};

@Controller('admin')
export class AdminController {
  constructor(
    private readonly adminAuthService: AdminAuthService,
    private readonly adminService: AdminService,
  ) {}

  @Post('login')
  login(@Body() body: AdminLoginBody) {
    return this.adminAuthService.login(body.email ?? '', body.password ?? '');
  }

  @UseGuards(AdminGuard)
  @Get('summary')
  summary() {
    return this.adminService.getSummary();
  }

  @UseGuards(AdminGuard)
  @Get('companies')
  companies() {
    return this.adminService.listCompanies();
  }

  @UseGuards(AdminGuard)
  @Patch('companies/:id')
  updateCompany(
    @Param('id', createUuidPipe()) id: string,
    @Body() body: UpdateCompanyBody,
  ) {
    return this.adminService.updateCompanyStatus(id, body.isActive as boolean);
  }

  @UseGuards(AdminGuard)
  @Get('operations')
  operations() {
    return this.adminService.getOperations();
  }

  @UseGuards(AdminGuard)
  @Get('rates')
  rates() {
    return this.adminService.getRates();
  }

  @UseGuards(AdminGuard)
  @Post('rates')
  createRate(@Body() body: CreateRateBody) {
    return this.adminService.createRate(body.currency, body.rate);
  }
}
