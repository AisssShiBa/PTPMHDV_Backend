import { IsDateString } from "class-validator";
import { MoneyCommandDto } from "./common.dto";

export class HoldDto extends MoneyCommandDto {
  @IsDateString()
  expiresAt!: string;
}
