import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import express, { type Request, type Response, type NextFunction } from 'express';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const server = express();
  server.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('ngrok-skip-browser-warning', '1');
    next();
  });

  const app = await NestFactory.create(AppModule, new ExpressAdapter(server));
  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Planning Poker running at http://localhost:${port}`);
}
bootstrap();
