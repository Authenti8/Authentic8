import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { CommercialController } from "./commercial.controller.js";
import { CommercialService } from "./commercial.service.js";

@Module({ imports: [AuthModule], controllers: [CommercialController], providers: [CommercialService] })
export class CommercialModule {}
