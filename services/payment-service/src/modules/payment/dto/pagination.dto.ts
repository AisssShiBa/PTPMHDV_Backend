import { IsEnum, IsNumberString, IsOptional, IsString } from 'class-validator';
import { PaymentType } from '../enums';

export class PaginationDto {
  @IsNumberString()
  @IsOptional()
  page?: string;

  @IsNumberString()
  @IsOptional()
  limit?: string;

  @IsString()
  @IsOptional()
  userId?: string;

  @IsEnum(PaymentType)
  @IsOptional()
  type?: PaymentType;

  @IsString()
  @IsOptional()
  status?: string;
}
