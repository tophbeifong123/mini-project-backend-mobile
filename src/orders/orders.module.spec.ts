import { isOrderWorkerEnabled } from './orders.module';

describe('OrdersModule worker role', () => {
  it('keeps the worker enabled by default for backward compatibility', () => {
    expect(isOrderWorkerEnabled(undefined)).toBe(true);
  });

  it('disables the worker only for an explicit false value', () => {
    expect(isOrderWorkerEnabled('false')).toBe(false);
    expect(isOrderWorkerEnabled('true')).toBe(true);
  });
});
