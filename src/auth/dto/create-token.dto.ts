import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** body ของ POST /api/v1/auth/token — `{ "userId": "user-999" }` */
export class CreateTokenDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64) // ตรงกับ orders.user_id VARCHAR(64)
  userId!: string;
}
