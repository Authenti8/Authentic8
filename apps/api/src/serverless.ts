import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { RequestListener } from "node:http";
import { AppModule } from "./app.module.js";
import { configureApplication } from "./application.js";
import { loadConfig } from "./config.js";

let handlerPromise: Promise<RequestListener> | undefined;

export function getServerlessHandler() {
  handlerPromise ??= createServerlessHandler().catch((error: unknown) => {
    handlerPromise = undefined;
    throw error;
  });
  return handlerPromise;
}

async function createServerlessHandler() {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    cors: false,
    rawBody: true,
  });
  configureApplication(app, config, {
    globalPrefix: "api/v1",
    shutdownHooks: false,
  });
  await app.init();
  return app.getHttpAdapter().getInstance() as RequestListener;
}
