import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * ปฏิเสธ 401 ทันทีถ้าไม่มี/JWT ไม่ถูกต้อง — **ก่อนแตะ Redis เสมอ** (§4.3)
 * เป็น Tier 0 ของ 4-Tier Defense
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
