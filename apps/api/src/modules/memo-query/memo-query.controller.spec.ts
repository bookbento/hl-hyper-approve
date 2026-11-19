import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { MemoQueryController } from './memo-query.controller';
import type { MemoQueryService } from './memo-query.service';
import type { MemoSearchNestService } from './memo-search.service';
import type { MemoReferenceNestService } from './memo-reference.service';

describe('SearchMemosDto sort validation', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { validate } = require('class-validator');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { plainToInstance } = require('class-transformer');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SearchMemosDto } = require('./dto/search-memos.dto');
  const errorsFor = async (body: object) =>
    (await validate(plainToInstance(SearchMemosDto, body))).map((e: { property: string }) => e.property);

  it('rejects unknown sort keys and directions', async () => {
    expect(await errorsFor({ sortBy: 'toString' })).toContain('sortBy');
    expect(await errorsFor({ sortDir: 'sideways' })).toContain('sortDir');
  });

  it('accepts known ones', async () => {
    expect(await errorsFor({ sortBy: 'status', sortDir: 'asc' })).toEqual([]);
  });
});

describe('MemoQueryController.searchMemos pageSize', () => {
  const search = { searchMemos: jest.fn().mockResolvedValue({ items: [] }) };
  const controller = new MemoQueryController(
    {} as MemoQueryService,
    search as unknown as MemoSearchNestService,
    {} as MemoReferenceNestService,
  );
  const req = { protocol: 'http', get: () => 'h' } as unknown as Request;
  const user = { id: 1 } as Parameters<MemoQueryController['searchMemos']>[1];

  beforeEach(() => search.searchMemos.mockClear());

  it.each([0, 101, 'lots', 2.5 as unknown as number])('rejects %p with 400', async (pageSize) => {
    await expect(
      controller.searchMemos({ pageSize } as never, user, req),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(search.searchMemos).not.toHaveBeenCalled();
  });

  it.each([1, 100, 'all', undefined])('accepts %p', async (pageSize) => {
    await controller.searchMemos({ pageSize } as never, user, req);
    expect(search.searchMemos).toHaveBeenCalled();
  });
});
