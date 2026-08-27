import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export interface TokenResponse {
  status: 'success';
  accessToken: string;
}

/**
 * จำลอง login (§4.2) — ไม่ตรวจรหัสผ่าน, **ไม่แตะ DB และไม่แตะ Redis**
 * โจทย์ระบุว่า endpoint นี้ไม่ถูกวัด performance
 */
@Injectable()
export class AuthService {
  constructor(private readonly jwtService: JwtService) {}

  issueToken(userId: string): TokenResponse {
    // claim `sub` คือแหล่งเดียวของ userId ทั้งระบบ (invariant CLAUDE.md §4 ข้อ 2)
    const accessToken = this.jwtService.sign({ sub: userId });

    return { status: 'success', accessToken };
  }
}
