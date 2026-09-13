import { Transform, Type } from "class-transformer";
import { IsEnum, IsIn, IsInt, IsOptional, Min } from "class-validator";
import { OwnerType } from "@prisma/client";
import { trim } from "./common.dto";

export class CreateWalletDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId!: number;

  @IsOptional()
  @IsEnum(OwnerType)
  ownerType?: OwnerType = OwnerType.USER;

  @IsOptional()
  @Transform(trim)
  @IsIn(["VND"])
  currency?: string = "VND";
}
