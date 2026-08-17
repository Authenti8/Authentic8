import { IsUUID } from "class-validator";

export class ReassignInterviewDto {
  @IsUUID() memberUserId!: string;
}
