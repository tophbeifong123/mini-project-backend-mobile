import { BadRequestException } from '@nestjs/common';

import { ProductsController } from './products.controller';
import type { ProductsService } from './products.service';

describe('ProductsController query parsing', () => {
  const listProducts = jest.fn().mockResolvedValue({
    data: [],
    meta: { total: 0, page: 1, limit: 10, totalPages: 0 },
  });
  const controller = new ProductsController({
    listProducts,
  } as unknown as ProductsService);

  beforeEach(() => listProducts.mockClear());

  it('uses the documented defaults when query is absent', async () => {
    await controller.listProducts({});

    expect(listProducts).toHaveBeenCalledWith(1, 10);
  });

  it('parses positive integers and clamps limit to the safety ceiling', async () => {
    await controller.listProducts({ page: '2', limit: '999' });

    expect(listProducts).toHaveBeenCalledWith(2, 100);
  });

  it.each([
    [{ page: '0' }],
    [{ page: '1.5' }],
    [{ page: 'not-a-number' }],
    [{ limit: ['10', '20'] }],
  ])('rejects invalid query input: %p', async (query) => {
    await expect(controller.listProducts(query)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(listProducts).not.toHaveBeenCalled();
  });
});
