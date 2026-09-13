import { Transform, Type } from "class-transformer";
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from "class-validator";
import { LedgerDirection, TransferType } from "@prisma/client";
import { MoneyCommandDto, trim } from "./common.dto";

export class CreditDto extends MoneyCommandDto {
  @IsOptional()
  @IsEnum(TransferType)
  transferType?: TransferType = TransferType.TOPUP;
}

export class DebitDto extends MoneyCommandDto {
  @IsOptional()
  @IsEnum(TransferType)
  transferType?: TransferType = TransferType.PAYMENT;
}

export class TransferDto extends MoneyCommandDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  fromUserId!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  toUserId!: number;
}

export class AdjustDto extends MoneyCommandDto {
  @IsEnum(LedgerDirection)
  direction!: LedgerDirection;

  @Transform(trim)
  @IsString()
  @MaxLength(500)
  @Matches(/\S/, { message: "reason must not be empty" })
  reason!: string;
}
