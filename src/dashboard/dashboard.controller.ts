import { Controller, Get, Query } from '@nestjs/common';
import { createUuidPipe } from '../common/uuid.pipe';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get()
  getHome(@Query('userId', createUuidPipe()) userId: string) {
    return this.dashboardService.getHome(userId);
  }
}
