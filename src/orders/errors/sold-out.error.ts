/**
 * permanent failure — retry ไม่มีทางสำเร็จ (CLAUDE.md §4 ข้อ 10)
 * worker ต้อง `return` ไม่ใช่ `throw` เมื่อเจอ error ตัวนี้
 */
export class SoldOutError extends Error {
  constructor(productId?: string) {
    super(
      productId
        ? `Product ${productId} is sold out (remaining_stock = 0)`
        : 'Product is sold out (remaining_stock = 0)',
    );
    this.name = 'SoldOutError';
    Object.setPrototypeOf(this, SoldOutError.prototype);
  }
}
