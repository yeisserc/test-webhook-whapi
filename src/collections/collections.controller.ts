import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { createUuidPipe } from '../common/uuid.pipe';
import { WhatsappBotService } from '../whatsapp-bot/whatsapp-bot.service';
import { CollectionsService } from './collections.service';
import { CreateCollectionDto } from './dto/create-collection.dto';
import type { UpdateCollectionDto } from './dto/update-collection.dto';

@Controller('collections')
export class CollectionsController {
  constructor(
    private readonly collectionsService: CollectionsService,
    private readonly whatsappBotService: WhatsappBotService,
  ) {}

  @Get()
  findAll(
    @Query('clientId') clientId?: string,
    @Query('userId') userId?: string,
  ) {
    return this.collectionsService.findAll({ clientId, userId });
  }

  @Get(':id')
  findOne(@Param('id', createUuidPipe()) id: string) {
    return this.collectionsService.findOne(id);
  }

  @Post()
  create(@Body() payload: CreateCollectionDto) {
    return this.collectionsService.create(payload);
  }

  @Patch(':id')
  update(
    @Param('id', createUuidPipe()) id: string,
    @Body() payload: UpdateCollectionDto,
  ) {
    return this.collectionsService.update(id, payload);
  }

  @Delete(':id')
  remove(@Param('id', createUuidPipe()) id: string) {
    return this.collectionsService.remove(id);
  }

  /**
   * Envía manualmente el cobro de la cuota en curso (WhatsApp + registro de envío).
   */
  @Post(':id/send-charge')
  sendCharge(@Param('id', createUuidPipe()) id: string) {
    return this.whatsappBotService.sendManualCharge(id);
  }
}
