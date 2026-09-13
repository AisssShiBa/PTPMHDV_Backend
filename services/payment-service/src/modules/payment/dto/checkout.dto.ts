import { IsEnum, IsNotEmpty, IsNumberString, IsString } from 'class-validator';
import { PaymentType } from '../enums';

export class CheckoutDto {
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @IsNumberString()
  @IsNotEmpty()
  amount!: string;

  @IsEnum(PaymentType)
  @IsNotEmpty()
  type!: PaymentType;

  @IsString()
  @IsNotEmpty()
  referenceId!: string;

  @IsString()
  @IsNotEmpty()
  idempotencyKey!: string;

  @IsString()
  @IsNotEmpty()
  callbackTopic!: string;
}
