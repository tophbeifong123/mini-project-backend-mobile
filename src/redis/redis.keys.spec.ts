import { RedisKeys } from './redis.keys';

describe('RedisKeys.compensated (CLAUDE.md §4 ข้อ 8)', () => {
  const jobId = 'order:user-999:p-1001';

  it('scopes the guard to one request, not to the (user, product) pair', () => {
    expect(RedisKeys.compensated(jobId, 'tok-a')).toBe(
      `compensated:${jobId}:tok-a`,
    );
  });

  it('does not collide across two requests that share the deterministic jobId', () => {
    // `jobId` ซ้ำเสมอเพราะเป็น deterministic — ถ้า guard ผูกกับ jobId อย่างเดียว
    // คำขอรอบสองของคนเดิมจะเจอ guard ของรอบแรกแล้วไม่คืนสต็อก = สต็อกหายถาวร
    expect(RedisKeys.compensated(jobId, 'tok-a')).not.toBe(
      RedisKeys.compensated(jobId, 'tok-b'),
    );
  });

  it('keeps guarding the retry chain of one request (same token → same key)', () => {
    // BullMQ retry อ่าน job.data เดิม จึงได้ requestToken เดิม → key เดิม → คืนซ้ำไม่ได้
    expect(RedisKeys.compensated(jobId, 'tok-a')).toBe(
      RedisKeys.compensated(jobId, 'tok-a'),
    );
  });

  it("is still matched by the reset script's delete pattern", () => {
    // reset.ts ลบด้วย SCAN MATCH pattern นี้ — glob `*` ของ Redis กิน `:` ด้วย
    // จึงครอบทั้ง key แบบใหม่และ key แบบเก่า (`compensated:{jobId}`) ที่ค้างอยู่
    const pattern = RedisKeys.compensated('*', '*');
    expect(pattern).toBe('compensated:*:*');

    const toRegExp = (glob: string): RegExp =>
      new RegExp(`^${glob.split('*').join('.*')}$`);
    expect(toRegExp(pattern).test(RedisKeys.compensated(jobId, 'tok-a'))).toBe(
      true,
    );
    expect(toRegExp(pattern).test(`compensated:${jobId}`)).toBe(true);
  });
});
