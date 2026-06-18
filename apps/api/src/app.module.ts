import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { LobbyModule } from './lobby/lobby.module';

@Module({
  imports: [LobbyModule],
  controllers: [AppController],
})
export class AppModule {}
