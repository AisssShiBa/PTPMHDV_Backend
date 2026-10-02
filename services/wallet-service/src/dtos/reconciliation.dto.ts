import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';

export enum AnomalyTypeFilter {
  ALL = 'ALL',
  NEGATIVE_BALANCE = 'NEGATIVE_BALANCE',
  BALANCE_DRIFT_QUICK = 'BALANCE_DRIFT_QUICK',
  BALANCE_DRIFT_FULL = 'BALANCE_DRIFT_FULL',
  TRANSACTION_UNBALANCED = 'TRANSACTION_UNBALANCED',
}

export class RunReconciliationDto {
  @IsOptional()
  @IsString()
  isFull?: string;
}

export class ReconciliationPaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit: number = 10;

  @IsOptional()
  @IsEnum(AnomalyTypeFilter)
  type?: AnomalyTypeFilter = AnomalyTypeFilter.ALL;
}
