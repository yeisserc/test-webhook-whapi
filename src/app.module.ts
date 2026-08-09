import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BankAutomationModule } from './bank-automation/bank-automation.module';
import { ClientsModule } from './clients/clients.module';
import { CollectionsModule } from './collections/collections.module';
import { CurrencyRatesModule } from './currency-rates/currency-rates.module';
import { OpenaiExtractionModule } from './openai-extraction/openai-extraction.module';
import { UsersModule } from './users/users.module';
import { WhatsappBotModule } from './whatsapp-bot/whatsapp-bot.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';


@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const port = Number(configService.get<string>('DB_PORT', '5432'));
        const host = configService.get<string>('DB_HOST', 'localhost');
        const shouldSynchronize = configService.get<string>('DB_SYNCHRONIZE', 'true') === 'true';
        const useSsl =
          configService.get<string>('DB_SSL') === 'true' ||
          host.includes('supabase.com');

        return {
          type: 'postgres' as const,
          host,
          port,
          username: configService.get<string>('DB_USER'),
          password: configService.get<string>('DB_PASSWORD'),
          database: configService.get<string>('DB_NAME'),
          autoLoadEntities: true,
          synchronize: shouldSynchronize,
          ssl: useSsl ? { rejectUnauthorized: false } : false,
        };
      },
    }),
    UsersModule,
    ClientsModule,
    CollectionsModule,
    CurrencyRatesModule,
    BankAutomationModule,
    OpenaiExtractionModule,
    WhatsappModule,
    WhatsappBotModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
