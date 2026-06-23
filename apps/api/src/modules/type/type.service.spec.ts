import { Test, TestingModule } from '@nestjs/testing';
import { TypeService } from './type.service';
import { PrismaService } from '../../prisma/prisma.service';

const mockPrisma = {
  memoType: {
    findMany: jest.fn(),
  },
};

describe('TypeService', () => {
  let service: TypeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TypeService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<TypeService>(TypeService);
    jest.clearAllMocks();
  });

  describe('findAll', () => {
    it('returns all memo types', async () => {
      const types = [{ id: 1, name: 'Annual' }, { id: 2, name: 'Memo' }];
      mockPrisma.memoType.findMany.mockResolvedValue(types);

      const result = await service.findAll();

      expect(result).toEqual(types);
      expect(mockPrisma.memoType.findMany).toHaveBeenCalledTimes(1);
    });

    it('returns empty array when no types exist', async () => {
      mockPrisma.memoType.findMany.mockResolvedValue([]);
      const result = await service.findAll();
      expect(result).toEqual([]);
    });
  });
});
