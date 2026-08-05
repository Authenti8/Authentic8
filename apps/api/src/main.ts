import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import { configureApplication } from "./application.js";
import { loadConfig } from "./config.js";

async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { cors: false });
  configureApplication(app, config);
  await app.listen(config.port, "0.0.0.0");
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
