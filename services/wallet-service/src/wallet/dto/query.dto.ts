import { Type } from "class-transformer";
import { IsDateString, IsEnum, IsInt, IsOptional, Min } from "class-validator";
import { OwnerType, WalletStatus } from "@prisma/client";
import { PaginationDto } from "./common.dto";

export class HistoryQueryDto extends PaginationDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsEnum(OwnerType)
  ownerType?: OwnerType = OwnerType.USER;
}

export class ListWalletsDto extends PaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId?: number;

  @IsOptional()
  @IsEnum(OwnerType)
  ownerType?: OwnerType;

  @IsOptional()
  @IsEnum(WalletStatus)
  status?: WalletStatus;
}
