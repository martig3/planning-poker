import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ServeStaticModule } from '@nestjs/serve-static';
import { RoomsModule } from './rooms/rooms.module.js';

@Module({
  imports: [
    EventEmitterModule.forRoot({ wildcard: true }),
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'public'),
      serveRoot: '/',
      exclude: ['/rooms/(.*)'],
    }),
    RoomsModule,
  ],
})
export class AppModule {}
