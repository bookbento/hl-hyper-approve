/**
 * MemoReferenceNestService (Nest)
 *
 * Port of backend/src/services/memoReference.service.ts — pure logic, no req/res.
 * Handles: searchMemosForReference, getMemoReferences, updateMemoReferences,
 *          getReferenceMemoContent
 *
 * canViewMemo permission is delegated to MemoAccessService (shared provider).
 */
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MemoAccessService } from './memo-access.service';

@Injectable()
export class MemoReferenceNestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly memoAccess: MemoAccessService,
  ) {}

  // ── GET /api/memos/search-for-reference ─────────────────────────────────────

  async searchMemosForReference(
    currentUserId: number,
    query: string,
    excludeIdsRaw: string,
    limitRaw: number,
  ) {
    const excludeIds = String(excludeIdsRaw || '')
      .split(',')
      .map((id) => Number(id.trim()))
      .filter((id) => !isNaN(id) && id > 0);
    const limit = Math.min(Number(limitRaw) || 10, 50);

    const whereCondition: any = {
      userId: currentUserId,
      id: { notIn: excludeIds },
    };

    if (query.length >= 2) {
      whereCondition.OR = [
        { subject: { contains: query, mode: 'insensitive' } },
        {
          memoNumberRecord: {
            memonumber: { contains: query, mode: 'insensitive' },
          },
        },
      ];
    }

    const memos = await this.prisma.masterMemo.findMany({
      where: whereCondition,
      select: {
        id: true,
        subject: true,
        createdAt: true,
        memoNumberRecord: { select: { memonumber: true } },
        statuses: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { status: { select: { name: true } } },
        },
        user: { select: { id: true, name: true, lastname: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    const filteredMemos = memos.filter((memo) => {
      const statusName = memo.statuses[0]?.status?.name || 'Draft';
      const statusUpper = statusName.toUpperCase();
      return (
        statusUpper !== 'DRAFT' &&
        statusUpper !== 'CANCELLED' &&
        statusUpper !== 'DELETED'
      );
    });

    return filteredMemos.map((memo) => ({
      id: memo.id,
      subject: memo.subject,
      memoNumber: (memo as any).memoNumberRecord?.memonumber || '',
      createdAt: memo.createdAt,
      status: memo.statuses[0]?.status?.name || 'Draft',
      createdBy: {
        id: memo.user.id,
        name: memo.user.name,
        lastname: memo.user.lastname,
      },
    }));
  }

  // ── GET /api/memos/:id/references ───────────────────────────────────────────

  async getMemoReferences(memoId: number, currentUserId: number) {
    const references = await this.prisma.memoReference.findMany({
      where: { mainMemoId: memoId },
      include: {
        referenceMemo: {
          select: {
            id: true,
            subject: true,
            createdAt: true,
            userId: true,
            memoNumberRecord: { select: { memonumber: true } },
            statuses: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { status: { select: { name: true } } },
            },
            user: {
              select: {
                id: true,
                name: true,
                lastname: true,
                profileImagePath: true,
              },
            },
            mainFiles: {
              select: { id: true, fileName: true, filePath: true, size: true },
            },
            attachedFiles: {
              select: {
                id: true,
                fileName: true,
                filePath: true,
                fileType: true,
                size: true,
              },
            },
            comments: {
              select: {
                id: true,
                comment: true,
                createdAt: true,
                user: {
                  select: {
                    id: true,
                    name: true,
                    lastname: true,
                    profileImagePath: true,
                  },
                },
                attachments: {
                  select: {
                    id: true,
                    filename: true,
                    url: true,
                    mimetype: true,
                    size: true,
                  },
                },
              },
              orderBy: { createdAt: 'asc' },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // D-6: Filter references by actual access permissions
    const accessibleReferences: typeof references = [];
    for (const ref of references) {
      const statusName = ref.referenceMemo.statuses[0]?.status?.name || '';
      if (statusName === 'Deleted') continue;
      const hasAccess = await this.memoAccess.canViewMemo(
        currentUserId,
        ref.referenceMemo.id,
      );
      if (hasAccess) accessibleReferences.push(ref);
    }

    return accessibleReferences.map((ref) => ({
      id: ref.referenceMemo.id,
      subject: ref.referenceMemo.subject,
      memoNumber: (ref.referenceMemo as any).memoNumberRecord?.memonumber || '',
      createdAt: ref.referenceMemo.createdAt,
      status: ref.referenceMemo.statuses[0]?.status?.name || 'Draft',
      createdBy: {
        id: ref.referenceMemo.user.id,
        name: ref.referenceMemo.user.name,
        lastname: ref.referenceMemo.user.lastname,
        profileImagePath: ref.referenceMemo.user.profileImagePath,
      },
      mainFiles: ref.referenceMemo.mainFiles,
      attachedFiles: ref.referenceMemo.attachedFiles,
      comments: ref.referenceMemo.comments,
      hasAccess: true,
    }));
  }

  // ── PUT /api/memos/:id/references ───────────────────────────────────────────

  async updateMemoReferences(
    memoId: number,
    currentUserId: number,
    referenceIds: number[],
  ) {
    const mainMemo = await this.prisma.masterMemo.findFirst({
      where: { id: memoId, userId: currentUserId },
      select: { id: true },
    });

    if (!mainMemo) {
      throw new NotFoundException('Memo not found or access denied');
    }

    const validReferenceIds: number[] = [];
    for (const refId of referenceIds) {
      const refMemo = await this.prisma.masterMemo.findFirst({
        where: { id: Number(refId), userId: currentUserId },
        select: { id: true },
      });

      if (refMemo && refMemo.id !== memoId) {
        validReferenceIds.push(refMemo.id);
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.memoReference.deleteMany({ where: { mainMemoId: memoId } });

      if (validReferenceIds.length > 0) {
        await tx.memoReference.createMany({
          data: validReferenceIds.map((refId) => ({
            mainMemoId: memoId,
            referenceMemoId: refId,
            createdBy: currentUserId,
          })),
        });
      }
    });

    return { success: true, referencesCount: validReferenceIds.length };
  }

  // ── GET /api/memos/:id/reference-content/:referenceId ───────────────────────

  async getReferenceMemoContent(
    memoId: number,
    referenceId: number,
    currentUserId: number,
  ) {
    const reference = await this.prisma.memoReference.findFirst({
      where: { mainMemoId: memoId, referenceMemoId: referenceId },
    });

    if (!reference) {
      throw new NotFoundException('Reference not found');
    }

    const referenceMemo = await this.prisma.masterMemo.findFirst({
      where: { id: referenceId },
      select: {
        id: true,
        subject: true,
        createdAt: true,
        userId: true,
        memoNumberRecord: { select: { memonumber: true } },
        statuses: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { status: { select: { name: true } } },
        },
        user: {
          select: {
            id: true,
            name: true,
            lastname: true,
            profileImagePath: true,
          },
        },
        mainFiles: {
          select: { id: true, fileName: true, filePath: true, size: true },
        },
        attachedFiles: {
          select: {
            id: true,
            fileName: true,
            filePath: true,
            fileType: true,
            size: true,
          },
        },
        comments: {
          select: {
            id: true,
            comment: true,
            createdAt: true,
            user: {
              select: {
                id: true,
                name: true,
                lastname: true,
                profileImagePath: true,
              },
            },
            attachments: {
              select: {
                id: true,
                filename: true,
                url: true,
                mimetype: true,
                size: true,
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!referenceMemo) {
      throw new NotFoundException('Reference memo not found');
    }

    // D-6: canViewMemo — authoritative permission check
    const hasAccess = await this.memoAccess.canViewMemo(currentUserId, referenceMemo.id);
    if (!hasAccess) {
      throw new ForbiddenException('Access denied');
    }

    if (referenceMemo.statuses[0]?.status?.name === 'Deleted') {
      throw new NotFoundException('Reference not found (deleted)');
    }

    return {
      id: referenceMemo.id,
      subject: referenceMemo.subject,
      memoNumber: (referenceMemo as any).memoNumberRecord?.memonumber || '',
      createdAt: referenceMemo.createdAt,
      status: referenceMemo.statuses[0]?.status?.name || 'Draft',
      createdBy: {
        id: referenceMemo.user.id,
        name: referenceMemo.user.name,
        lastname: referenceMemo.user.lastname,
        profileImagePath: referenceMemo.user.profileImagePath,
      },
      mainFiles: referenceMemo.mainFiles,
      attachedFiles: referenceMemo.attachedFiles,
      comments: referenceMemo.comments,
      hasAccess: true,
    };
  }
}
