import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { AuthService } from './auth.service';
// `TokenResponse` เป็น interface ล้วน — ต้องนำเข้าแบบ `import type`
// ไม่งั้น emitDecoratorMetadata จะพยายาม emit `design:returntype` ที่ชี้ไปยัง type ที่ไม่มีตัวตนตอน runtime (TS1272)
import type { TokenResponse } from './auth.service';
import { CreateTokenDto } from './dto/create-token.dto';

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** POST /api/v1/auth/token → **200** `{ status: 'success', accessToken }` (CLAUDE.md §3) */
  @Post('token')
  @HttpCode(HttpStatus.OK)
  createToken(@Body() dto: CreateTokenDto): TokenResponse {
    return this.authService.issueToken(dto.userId);
  }
}
