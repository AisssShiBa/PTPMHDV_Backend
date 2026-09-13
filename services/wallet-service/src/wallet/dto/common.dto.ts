import { Transform, Type } from "class-transformer";
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { OwnerType } from "@prisma/client";

export const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

export const moneyString = ({ value }: { value: unknown }) =>
  typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : value;

export class OwnerIdParamDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId!: number;
}

export class OwnerTypeQueryDto {
  @IsOptional()
  @IsEnum(OwnerType)
  ownerType?: OwnerType = OwnerType.USER;
}

export class MoneyCommandDto {
  @Transform(moneyString)
  @Matches(/^(?:0|[1-9]\d{0,17})(?:\.\d{1,2})?$/, {
    message: "amount must be a positive decimal with at most 2 decimal places",
  })
  amount!: string;

  @Transform(trim)
  @IsString()
  @MaxLength(255)
  @Matches(/\S/, { message: "referenceId must not be empty" })
  referenceId!: string;
}

export class ReferenceDto {
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  @Matches(/\S/, { message: "referenceId must not be empty" })
  referenceId!: string;
}

export class PaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
