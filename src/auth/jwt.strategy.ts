import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

/** payload ที่เรา sign เอง (§4.1) */
export interface JwtPayload {
  sub: string;
  iat?: number;
  exp?: number;
}

/** สิ่งที่ถูกแนบไว้ที่ `request.user` หลังผ่าน JwtAuthGuard */
export interface AuthenticatedUser {
  userId: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
      algorithms: ['HS256'],
    });
  }

  /**
   * ⚠️ **zero I/O** — ห้าม query DB/Redis ที่นี่เด็ดขาด (§4.1)
   * ที่ 500 concurrent มันจะกลายเป็นคอขวดทันที และเราไม่มีตาราง users ให้ query อยู่แล้ว
   */
  validate(payload: JwtPayload): AuthenticatedUser {
    return { userId: payload.sub };
  }
}
