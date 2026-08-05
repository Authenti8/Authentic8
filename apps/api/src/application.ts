import { ValidationPipe } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "./config.js";

export function configureApplication(app: NestExpressApplication, config: AppConfig) {
  app.set("trust proxy", config.trustedProxies.length ? config.trustedProxies : false);
  app.setGlobalPrefix("v1");
  app.enableCors({ origin: config.appOrigin, credentials: true });
  app.use(sameOriginGuard(config.appOrigin));
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.enableShutdownHooks();
}

function sameOriginGuard(appOrigin: string) {
  return (request: Request, response: Response, next: NextFunction) => {
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    const origin = request.headers.origin;
    if (unsafe && origin && origin !== appOrigin) {
      response.status(403).json({ error: "Cross-origin request blocked." });
      return;
    }
    next();
  };
}
