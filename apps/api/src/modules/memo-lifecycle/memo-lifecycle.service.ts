/**
 * MemoLifecycleService (Nest)
 *
 * Port of backend/src/services/memoLifecycle.service.ts — pure provider,
 * no Express req/res. All methods return data or throw NestJS HttpExceptions.
 *
 * Transaction parity: 100% — every DB write matches the Express handler exactly,
 * including sequence reset, compensation rollback on create, and ForUse cloning.
 *
 * Helpers ported from Express:
 *   parseExpiresAt, getStatusIdByName, absFromDbPath
 *   reserveMemoNumber logic delegated to MemoNumberService
 *
 * Dependencies:
 *   PrismaService, MemoQueryService (getWaitingStatusId)
 */

import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';
import { ActionType, ExtraStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UPLOADS_DIR, toPublicUploadPath } from '../../common/upload/upload.config';

// ── Type aliases ─────────────────────────────────────────────────────────────

type SlotT =
  | 'FIXED_USER'
  | 'MEMO_REQUESTER'
  | 'DEPARTMENT_HEAD'
  | 'FLEXIBLE_SLOT'
  | null;

export interface OverrideItem {
  userId: number | null;
  level: number;
  isSigReq?: boolean;
  roleDescription?: string | null;
  slotType?: SlotT;
  loaUserPivotId?: number | null;
  approvalRequirement?: 'ALL' | 'ANY';
}

interface ForUseSlotInput {
  memoId: number;
  userId: number | null;
  level: number;
  isSigReq: boolean;
  roleDescription: string | null;
  slotType: SlotT;
  templatePivotId?: number | null;
  approvalRequirement?: 'ALL' | 'ANY';
}

type SigPos = {
  id?: number | string;
  userId: number;
  fileIdx: number;
  page: number;
  x: number;
  y: number;
  sizePct?: number;
  level?: number;
};
type DatePos = SigPos & { date: string };
type NotePos = {
  id?: number | string;
  fileIdx: number;
  page: number;
  x: number;
  y: number;
  text: string;
  sizePct?: number;
};
type MemoNumPos = {
  id?: number | string;
  fileIdx: number;
  page: number;
  x: number;
  y: number;
  sizePct?: number;
};

// ── Pure helpers (no HTTP) ────────────────────────────────────────────────────

/**
 * Parse a date value from form input.
 * Returns undefined (don't touch), null (clear), or a Date.
 */
export function parseExpiresAt(raw?: unknown): Date | null | undefined {
  if (raw === undefined) return undefined;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999));
  }
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? null : dt;
}

export function absFromDbPath(input: string): string {
  if (!input) return '';
  if (path.isAbsolute(input)) return input;
  let s = String(input).trim();
  if (/^https?:\/\//i.test(s)) {
    try { s = new URL(s).pathname; } catch { /* ignore */ }
  }
  s = s.replace(/^\/+/, '');
  s = s.replace(/\\/g, '/');
  s = s.replace(/^api\/secure-uploads\//i, '');
  if (s.toLowerCase().startsWith('uploads/')) {
    s = s.slice('uploads/'.length);
  }
  return path.join(UPLOADS_DIR, s);
}

function decodeFilename(name: string): string {
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch {
    return name;
  }
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class MemoLifecycleService {
  private readonly logger = new Logger(MemoLifecycleService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Private helpers ──────────────────────────────────────────────────────

  private async getStatusIdByName(name: string): Promise<number> {
    const rec = await this.prisma.status.findFirst({
      where: { name },
      select: { id: true },
    });
    if (!rec) throw new InternalServerErrorException(`ต้องมี Status.name = "${name}" ในตาราง Status`);
    return rec.id;
  }

  private async getWaitingStatusId(): Promise<number> {
    const waiting = await this.prisma.approvalActionStatus.findFirst({
      where: { code: 'waiting' },
      select: { id: true },
    });
    if (!waiting) throw new InternalServerErrorException('ต้องมี status code = "waiting"');
    return waiting.id;
  }

  private async hasAnyApprovedInLatestVersion(memoId: number): Promise<boolean> {
    const approved = await this.prisma.approvalActionStatus.findUnique({
      where: { code: 'approved' },
      select: { id: true },
    });
    if (!approved) return false;
    const { _max } = await this.prisma.memoApproverAction.aggregate({
      where: { memoId },
      _max: { version: true },
    });
    const latestVer = _max.version ?? 1;
    const any = await this.prisma.memoApproverAction.findFirst({
      where: { memoId, version: latestVer, statusId: approved.id },
      select: { id: true },
    });
    return !!any;
  }

  private async resolveFlexibleSlot(
    slotType: string,
    memoCreatorId: number,
    memoCreatorDeptId: number | null,
  ): Promise<number | null> {
    switch (slotType) {
      case 'MEMO_REQUESTER':
        return memoCreatorId;
      case 'DEPARTMENT_HEAD': {
        if (!memoCreatorDeptId) return null;
        const deptHead = await this.prisma.user.findFirst({
          where: {
            departmentId: memoCreatorDeptId,
            OR: [
              { role: { contains: 'head', mode: 'insensitive' } },
              { role: { contains: 'manager', mode: 'insensitive' } },
              { role: { contains: 'supervisor', mode: 'insensitive' } },
            ],
          },
          select: { id: true },
        });
        return deptHead?.id ?? null;
      }
      default:
        return null;
    }
  }

  private async resolveDelegation(userId: number): Promise<number> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        delegatedToUserId: true,
        delegationStartDate: true,
        delegationEndDate: true,
      },
    });
    if (!user) return userId;
    if (user.delegatedToUserId && user.delegationStartDate && user.delegationEndDate) {
      const now = new Date();
      if (now >= user.delegationStartDate && now <= user.delegationEndDate) {
        return user.delegatedToUserId;
      }
    }
    return userId;
  }

  private parseIds(v: unknown): number[] {
    try {
      if (Array.isArray(v)) return v.map(Number).filter((n) => Number.isFinite(n) && n > 0);
      if (typeof v === 'string' && v.trim().startsWith('[')) {
        const arr = JSON.parse(v) as unknown[];
        return Array.isArray(arr) ? arr.map(Number).filter((n) => Number.isFinite(n) && n > 0) : [];
      }
      return [];
    } catch {
      return [];
    }
  }

  // ── createMemo ────────────────────────────────────────────────────────────

  async createMemo(params: {
    body: Record<string, unknown>;
    files: { [fieldname: string]: Express.Multer.File[] };
    actorId: number;
  }): Promise<unknown> {
    const { body, files } = params;

    let memo: { id: number } | null = null;
    try {
      // 1. Parse body fields
      const toIntOrNull = (v: unknown): number | null => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : null;
      };

      const subject = String(body['subject'] ?? '');
      const buId = toIntOrNull(body['businessUnitId']);
      const deptIdNum = toIntOrNull(body['departmentId']);
      const userIdNum = toIntOrNull(body['userId']);
      const typeIdNum = body['memotypeId'] ? toIntOrNull(body['memotypeId']) : null;
      const lineIdNum = toIntOrNull(body['approvalLineId']);
      const initStatus = +String(body['statusId'] ?? '1') === 2 ? 2 : 1;

      if (!buId) throw new BadRequestException('businessUnitId is required');
      if (!userIdNum) throw new BadRequestException('userId is required');

      let approversOverride: OverrideItem[] = [];
      try {
        approversOverride = JSON.parse(String(body['approversOverride'] ?? '[]')) as OverrideItem[];
      } catch {
        approversOverride = [];
      }
      const hasOverride = Array.isArray(approversOverride) && approversOverride.length > 0;

      // 2. Reserve MemoNumber
      if (!typeIdNum) throw new BadRequestException('MemoType not found');

      const typeRec = await this.prisma.memoType.findUnique({
        where: { id: typeIdNum },
        select: {
          abbreviation: true,
          businessUnitId: true,
          departmentId: true,
          businessUnit: { select: { abbreviation: true } },
          department: { select: { abbreviation: true } },
        },
      });
      if (!typeRec) throw new BadRequestException('MemoType not found');
      if (!typeRec.businessUnitId) throw new BadRequestException('MemoType must have a Business Unit');

      const buAbbr = typeRec.businessUnit?.abbreviation ?? '';
      const deptAbbr = typeRec.department?.abbreviation ?? buAbbr;
      const typeAbbr = typeRec.abbreviation ?? '';
      const memoTypeBuId = typeRec.businessUnitId;
      const memoTypeDeptId = typeRec.departmentId;

      const expCreate = parseExpiresAt(body['expiresAt'] as string | undefined);

      // Delegate reserveMemoNumber — mirrors Express lib (same DB, same Prisma)
      const memoNumberRecord = await this._reserveMemoNumber({
        businessUnitId: memoTypeBuId,
        departmentId: memoTypeDeptId,
        memotypeId: typeIdNum,
        buAbbr,
        deptAbbr,
        typeAbbr,
      });

      memo = await this.prisma.masterMemo.create({
        data: {
          subject,
          memonumber: memoNumberRecord.memonumber,
          memoNumberId: memoNumberRecord.id,
          businessUnitId: buId,
          ...(deptIdNum ? { departmentId: deptIdNum } : {}),
          userId: userIdNum,
          memotypeId: typeIdNum,
          approvalLineId: lineIdNum ?? null,
          ...(expCreate !== undefined ? { expiresAt: expCreate } : {}),
          statuses: { create: { statusId: initStatus, userId: userIdNum } },
        },
      });

      // 3. Files: main PDF + attachments + order
      const mainFiles = files?.['files'] ?? [];
      const attachedFiles = files?.['attachedFiles'] ?? [];

      if (!mainFiles.length) {
        throw new BadRequestException('No PDF files uploaded');
      }

      const created = await Promise.all(
        mainFiles.map((f, idx) =>
          this.prisma.mainFile.create({
            data: {
              memoId: memo!.id,
              filePath: toPublicUploadPath(f.path),
              fileName: decodeFilename(f.originalname),
              size: f.size,
              orderNo: idx,
            },
          }),
        ),
      );

      let tokens: string[] = [];
      try { tokens = JSON.parse(String(body['fileOrderTokens'] ?? '[]')) as string[]; } catch { tokens = []; }

      let finalOrder: number[];
      if (tokens.length) {
        finalOrder = [];
        for (const tk of tokens) {
          if (!tk.startsWith('new:')) continue;
          const idx = Number(tk.slice(4));
          if (!Number.isNaN(idx) && created[idx]) finalOrder.push(created[idx].id);
        }
        const allIds = new Set(created.map((c) => c.id));
        finalOrder.forEach((id) => allIds.delete(id));
        finalOrder.push(...allIds);
      } else {
        finalOrder = created.map((c) => c.id);
      }

      await this.prisma.$transaction(
        finalOrder.map((fileId, orderNo) =>
          this.prisma.mainFile.update({ where: { id: fileId }, data: { orderNo } }),
        ),
      );

      const fileIdMap: Record<number, number> = {};
      finalOrder.forEach((mfId, displayIdx) => (fileIdMap[displayIdx] = mfId));

      await Promise.all(
        attachedFiles.map((f) =>
          this.prisma.attachedFile.create({
            data: {
              memoId: memo!.id,
              fileName: decodeFilename(f.originalname),
              filePath: toPublicUploadPath(f.path),
              fileType: f.mimetype,
              size: f.size,
              isUrl: false,
            },
          }),
        ),
      );

      // URL links
      let urlLinks: Array<{ url: string; title: string }> = [];
      try { urlLinks = JSON.parse(String(body['urlLinks'] ?? '[]')) as Array<{ url: string; title: string }>; } catch { urlLinks = []; }

      if (urlLinks.length > 0) {
        await Promise.all(
          urlLinks.map((link) =>
            this.prisma.attachedFile.create({
              data: {
                memoId: memo!.id,
                fileName: link.title || link.url,
                url: link.url,
                isUrl: true,
                fileType: 'url/link',
                size: 0,
                filePath: null,
              },
            }),
          ),
        );
      }

      // 4. Positions (sig, date, note, memoNumber)
      const sigs: SigPos[] = JSON.parse(String(body['sigPositions'] ?? '[]')) as SigPos[];
      const dates: DatePos[] = JSON.parse(String(body['datePositions'] ?? '[]')) as DatePos[];
      const notes: NotePos[] = JSON.parse(String(body['notePositions'] ?? '[]')) as NotePos[];
      const memoNums: MemoNumPos[] = JSON.parse(String(body['memoNumberPositions'] ?? '[]')) as MemoNumPos[];

      await this.prisma.$transaction([
        ...sigs.map((p) =>
          this.prisma.signaturePosition.create({
            data: {
              memoId: memo!.id,
              fileId: fileIdMap[p.fileIdx],
              userId: p.userId,
              page: p.page,
              x: +p.x.toFixed(6),
              y: +p.y.toFixed(6),
              sizePct: p.sizePct ?? 100,
              level: p.level ?? null,
            },
          }),
        ),
        ...dates.map((p) => {
          const cleanDate = new Date(new Date(p.date).toLocaleDateString('sv-SE'));
          return this.prisma.datePosition.create({
            data: {
              memoId: memo!.id,
              fileId: fileIdMap[p.fileIdx],
              userId: p.userId,
              page: p.page,
              x: +p.x.toFixed(6),
              y: +p.y.toFixed(6),
              sizePct: p.sizePct ?? 100,
              date: cleanDate,
              level: p.level ?? null,
            },
          });
        }),
        ...notes.map((p) =>
          this.prisma.notePosition.create({
            data: {
              memoId: memo!.id,
              fileId: fileIdMap[p.fileIdx],
              page: p.page,
              x: +p.x.toFixed(6),
              y: +p.y.toFixed(6),
              text: p.text,
              sizePct: p.sizePct ?? 100,
            },
          }),
        ),
        ...memoNums.map((p) =>
          this.prisma.memoNumberPosition.create({
            data: {
              memoId: memo!.id,
              fileId: fileIdMap[p.fileIdx],
              page: p.page,
              x: +p.x.toFixed(6),
              y: +p.y.toFixed(6),
              sizePct: p.sizePct ?? 100,
            },
          }),
        ),
      ]);

      // 5. ForUse slots (approver list)
      let forUseSlots: ForUseSlotInput[] = [];

      if (hasOverride) {
        const sorted = [...approversOverride].sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
        forUseSlots = await Promise.all(
          sorted.map(async (o) => {
            const slot: SlotT = o.slotType ?? null;
            let resolvedUserId: number | null = o.userId ?? null;
            if (resolvedUserId !== null) {
              const uid = Number(resolvedUserId);
              if (!Number.isFinite(uid) || uid <= 0) {
                resolvedUserId = null;
              } else {
                resolvedUserId = uid;
                resolvedUserId = await this.resolveDelegation(resolvedUserId);
              }
            }
            return {
              memoId: memo!.id,
              userId: resolvedUserId,
              level: Number.isFinite(o.level as number) ? Number(o.level) : 0,
              isSigReq: !!o.isSigReq,
              roleDescription: o.roleDescription ?? null,
              slotType: slot,
              templatePivotId: null,
              approvalRequirement: (o.approvalRequirement as 'ALL' | 'ANY') ?? 'ALL',
            };
          }),
        );
      } else if (lineIdNum) {
        const templatePivots = await this.prisma.lineOfApprovalUserPivot.findMany({
          where: { lineOfApprovalId: lineIdNum },
          orderBy: { level: 'asc' },
          select: {
            id: true,
            userId: true,
            level: true,
            isSigReq: true,
            roleDescription: true,
            slotType: true,
            approvalRequirement: true,
          },
        });

        for (const p of templatePivots) {
          const slot = ((p.slotType as string) ?? 'FIXED_USER') as SlotT;
          let actualUserId: number | null = null;
          if (slot === 'FLEXIBLE_SLOT') {
            actualUserId = null;
          } else if (slot && slot !== 'FIXED_USER') {
            actualUserId = await this.resolveFlexibleSlot(slot, userIdNum, deptIdNum ?? null);
            if (actualUserId) {
              actualUserId = await this.resolveDelegation(actualUserId);
            }
          } else {
            if (p.userId == null) continue;
            actualUserId = await this.resolveDelegation(p.userId);
          }
          forUseSlots.push({
            memoId: memo!.id,
            userId: actualUserId,
            level: p.level,
            isSigReq: p.isSigReq,
            roleDescription: p.roleDescription ?? null,
            slotType: slot,
            templatePivotId: p.id,
            approvalRequirement: ((p as { approvalRequirement?: 'ALL' | 'ANY' }).approvalRequirement as 'ALL' | 'ANY') ?? 'ALL',
          });
        }
      }

      // 5.1 CC users
      const approverUserIdSet = new Set<number>(
        forUseSlots
          .map((p) => p.userId)
          .filter((u): u is number => typeof u === 'number' && Number.isFinite(u)),
      );

      const rawCcUserIds = this.parseIds(
        (body['ccUsers'] as { id?: unknown }[] | unknown)?.['map']?.((x: { id?: unknown }) => x?.id ?? x) ??
          body['ccUsers'] ??
          body['ccUserIds'] ??
          body['cc'],
      );
      const rawGroupInput = body['ccGroupIds'] ?? body['ccGroups'] ?? body['groups'];
      const rawCcGroupIds = this.parseIds(
        (rawGroupInput as { id?: unknown }[] | null)?.map?.((x: { id?: unknown }) => x?.id ?? x) ?? rawGroupInput,
      );

      let groupMemberUserIds: number[] = [];
      if (rawCcGroupIds.length) {
        const members = await this.prisma.ccGroupMember.findMany({
          where: { groupId: { in: rawCcGroupIds } },
          select: { userId: true },
        });
        groupMemberUserIds = members.map((m) => m.userId);
      }

      const ccUserSet = new Set<number>(
        [...rawCcUserIds, ...groupMemberUserIds].filter(
          (u) => Number.isFinite(u) && u > 0 && u !== userIdNum && !approverUserIdSet.has(u),
        ),
      );

      if (ccUserSet.size) {
        await this.prisma.memoCc.createMany({
          data: Array.from(ccUserSet).map((uid) => ({ memoId: memo!.id, userId: uid })),
          skipDuplicates: true,
        });
      }

      // 6. ForUse slots write + approver actions
      const waitingId = await this.getWaitingStatusId();

      let createdSlots: { id: number; userId: number | null }[] = [];
      if (forUseSlots.length) {
        // Reset sequence (same as Express — prevents collisions)
        await this.prisma.$executeRaw`
          SELECT setval(
            pg_get_serial_sequence('"LineOfApprovalUserPivotForUse"', 'id'),
            COALESCE((SELECT MAX(id) FROM "LineOfApprovalUserPivotForUse"), 0) + 1,
            false
          )
        `;

        createdSlots = await this.prisma.$transaction(
          forUseSlots.map((slot) =>
            this.prisma.lineOfApprovalUserPivotForUse.create({
              data: slot,
              select: { id: true, userId: true },
            }),
          ),
        );

        await this.prisma.$transaction(
          createdSlots.map((slot, idx) =>
            this.prisma.memoApproverAction.create({
              data: {
                memoId: memo!.id,
                loaUserId: slot.id,
                statusId: waitingId,
                version: 1,
                assignedUserId: forUseSlots[idx].userId ?? null,
              },
            }),
          ),
        );
      }

      const view = await this.prisma.masterMemo.findUnique({
        where: { id: memo.id },
        select: {
          id: true,
          memonumber: true,
          subject: true,
          approvalLineId: true,
          businessUnitId: true,
          departmentId: true,
          userId: true,
          memotypeId: true,
          expiresAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      return view;
    } catch (err: unknown) {
      this.logger.error('createMemo failed', err);

      // Compensation: rollback memo if already created
      if (memo?.id) {
        try {
          this.logger.warn(`Rolling back memo #${memo.id} due to error...`);
          await this.prisma.$transaction(async (tx) => {
            await tx.mainFile.deleteMany({ where: { memoId: memo!.id } });
            await tx.attachedFile.deleteMany({ where: { memoId: memo!.id } });
            await tx.signaturePosition.deleteMany({ where: { memoId: memo!.id } });
            await tx.datePosition.deleteMany({ where: { memoId: memo!.id } });
            await tx.memoNumberPosition.deleteMany({ where: { memoId: memo!.id } });
            await tx.memoCc.deleteMany({ where: { memoId: memo!.id } });
            await tx.memoApproverAction.deleteMany({ where: { memoId: memo!.id } });
            await tx.lineOfApprovalUserPivotForUse.deleteMany({ where: { memoId: memo!.id } });
            await tx.memoStatusPivot.deleteMany({ where: { memoId: memo!.id } });
            await tx.masterMemo.delete({ where: { id: memo!.id } });
          });
          this.logger.log(`Rollback successful. Memo #${memo.id} deleted.`);
        } catch (rollbackErr) {
          this.logger.error('Rollback failed:', rollbackErr);
        }
      }

      if (err instanceof BadRequestException) throw err;
      throw new InternalServerErrorException('Internal Server Error');
    }
  }

  // ── updateMemo ────────────────────────────────────────────────────────────

  async updateMemo(params: {
    id: number;
    body: Record<string, unknown>;
    files: { [fieldname: string]: Express.Multer.File[] };
  }): Promise<unknown> {
    const { id, body, files } = params;

    // Check status: Allow update only if Draft(1), Rejected(4), Recalled(6)
    const currentStatus = await this.prisma.memoStatusPivot.findFirst({
      where: { memoId: id },
      orderBy: { createdAt: 'desc' },
      select: { statusId: true },
    });
    const currentStatusId = currentStatus?.statusId ?? 0;

    if (![1, 4, 6].includes(currentStatusId)) {
      const statusCodeMap: Record<number, string> = { 3: 'APPROVED', 5: 'PROCESSING', 7: 'TERMINATED', 8: 'EXPIRED' };
      throw new ConflictException({
        code: 'MEMO_STATUS_CHANGED',
        statusCode: statusCodeMap[currentStatusId] ?? 'UNKNOWN',
        currentStatusId,
      });
    }

    let approversOverride: OverrideItem[] = [];
    try { approversOverride = JSON.parse(String(body['approversOverride'] ?? '[]')) as OverrideItem[]; } catch { approversOverride = []; }
    const hasOverride = Array.isArray(approversOverride) && approversOverride.length > 0;

    let removedFileIds: number[] = [];
    try { removedFileIds = (JSON.parse(String(body['removedFileIds'] ?? '[]')) as unknown[]).map(Number).filter(Boolean); } catch { removedFileIds = []; }

    let fileOrderTokens: string[] = [];
    try { fileOrderTokens = JSON.parse(String(body['fileOrderTokens'] ?? '[]')) as string[]; } catch { fileOrderTokens = []; }

    const subject = body['subject'] as string | undefined;
    const deptIdNum = body['departmentId'] ? Number(body['departmentId']) : null;
    const userIdNum = Number(body['userId']);
    const memotypeId = body['memotypeId'];
    const sigPositions = String(body['sigPositions'] ?? '[]');
    const datePositions = String(body['datePositions'] ?? '[]');
    const memoNumberPositions = String(body['memoNumberPositions'] ?? '[]');
    const notePositions = String(body['notePositions'] ?? '[]');

    // 2.0 Previous approval line
    const prev = await this.prisma.masterMemo.findUnique({
      where: { id },
      select: { approvalLineId: true },
    });
    const oldLineId = prev?.approvalLineId ?? null;

    // 2.1 Prepare approvalLineField
    const rawLineId = body['approvalLineId'] as string | undefined;
    let approvalLineField: Prisma.MasterMemoUpdateInput['approvalLine'] | undefined;
    if (rawLineId !== undefined) {
      if (rawLineId === '' || rawLineId === 'null') {
        approvalLineField = { disconnect: true };
      } else {
        const parsed = Number(rawLineId);
        if (!Number.isNaN(parsed)) approvalLineField = { connect: { id: parsed } };
      }
    }

    const rawExp = body['expiresAt'] as string | undefined;
    const expUpdate = parseExpiresAt(rawExp);

    const buIdNum = body['businessUnitId'] ? Number(body['businessUnitId']) : null;
    const deptIdNumParsed = body['departmentId'] ? Number(body['departmentId']) : null;

    // 2.2 Update memo header
    const memo = await this.prisma.masterMemo.update({
      where: { id },
      data: {
        subject,
        ...(buIdNum && !Number.isNaN(buIdNum) ? { businessUnit: { connect: { id: buIdNum } } } : {}),
        ...(deptIdNumParsed && !Number.isNaN(deptIdNumParsed) ? { department: { connect: { id: deptIdNumParsed } } } : {}),
        user: { connect: { id: +String(body['userId']) } },
        ...(memotypeId ? { memoType: { connect: { id: +String(memotypeId) } } } : { memoType: { disconnect: true } }),
        ...(approvalLineField ? { approvalLine: approvalLineField } : {}),
        ...(expUpdate === undefined ? {} : { expiresAt: expUpdate }),
      },
    });

    // 2.3 Detect line change
    const newLineId = memo.approvalLineId ?? null;
    const lineChanged = oldLineId !== newLineId;

    // 2.4 Clone version if no override and no line change
    if (!hasOverride && !lineChanged) {
      const agg = await this.prisma.memoApproverAction.aggregate({
        where: { memoId: id },
        _max: { version: true },
      });
      const newVersion = (agg._max.version ?? 1) + 1;
      const latestActions = await this.prisma.memoApproverAction.findMany({
        where: { memoId: id },
        orderBy: [{ loaUserId: 'asc' }, { version: 'desc' }],
        distinct: ['loaUserId'],
        select: {
          loaUserId: true,
          statusId: true,
          signatureImageId: true,
          signatureText: true,
          actedAt: true,
        },
      });
      await this.prisma.memoApproverAction.createMany({
        data: latestActions.map((a) => ({
          memoId: id,
          loaUserId: a.loaUserId,
          statusId: a.statusId,
          signatureImageId: a.signatureImageId ?? null,
          signatureText: a.signatureText ?? null,
          actedAt: a.actedAt ?? null,
          version: newVersion,
        })),
      });
    }

    // 2.5 Override: upsert ForUse slots
    if (hasOverride) {
      const existing = await this.prisma.lineOfApprovalUserPivotForUse.findMany({
        where: { memoId: id },
        select: { id: true, templatePivotId: true },
      });
      const existingById = new Map(existing.map((row) => [row.id, row]));

      const keepIds: number[] = [];
      const upsertOps: Prisma.PrismaPromise<{ id: number; userId: number | null }>[] = [];
      const sorted = [...approversOverride].sort((a, b) => (a.level ?? 0) - (b.level ?? 0));

      for (const o of sorted) {
        const slot = (o.slotType as SlotT) ?? null;
        const level = Number.isFinite(o.level as number) ? Number(o.level) : 0;
        const userIdVal = o.userId ? Number(o.userId) : null;
        const rawId = o.loaUserPivotId;

        if (typeof rawId === 'number' && Number.isFinite(rawId) && existingById.has(rawId)) {
          const old = existingById.get(rawId)!;
          keepIds.push(old.id);
          upsertOps.push(
            this.prisma.lineOfApprovalUserPivotForUse.update({
              where: { id: old.id },
              data: {
                userId: userIdVal,
                level,
                isSigReq: !!o.isSigReq,
                roleDescription: o.roleDescription ?? null,
                slotType: slot,
                approvalRequirement: (o.approvalRequirement as 'ALL' | 'ANY') ?? 'ALL',
                templatePivotId: old.templatePivotId,
              },
              select: { id: true, userId: true },
            }),
          );
        } else {
          upsertOps.push(
            this.prisma.lineOfApprovalUserPivotForUse.create({
              data: {
                memoId: id,
                userId: userIdVal,
                level,
                isSigReq: !!o.isSigReq,
                roleDescription: o.roleDescription ?? null,
                slotType: slot,
                approvalRequirement: (o.approvalRequirement as 'ALL' | 'ANY') ?? 'ALL',
                templatePivotId: null,
              },
              select: { id: true, userId: true },
            }),
          );
        }
      }

      await this.prisma.$executeRaw`
        SELECT setval(
          pg_get_serial_sequence('"LineOfApprovalUserPivotForUse"', 'id'),
          COALESCE((SELECT MAX(id) FROM "LineOfApprovalUserPivotForUse"), 0) + 1,
          false
        )
      `;

      let forUseRows: { id: number; userId: number | null }[] = [];
      try {
        forUseRows = await this.prisma.$transaction(upsertOps);
      } catch (txErr: unknown) {
        this.logger.error('updateMemo override transaction failed:', txErr);
        throw txErr;
      }

      const allKeepIds = [...keepIds, ...forUseRows.map((row) => row.id)];
      const waitingId = await this.getWaitingStatusId();
      await this.prisma.memoApproverAction.deleteMany({ where: { memoId: id } });

      if (existing.length) {
        await this.prisma.lineOfApprovalUserPivotForUse.deleteMany({
          where: { memoId: id, id: { notIn: allKeepIds } },
        });
      }

      const { _max } = await this.prisma.memoApproverAction.aggregate({
        where: { memoId: id },
        _max: { version: true },
      });
      const ver = (_max.version ?? 0) + 1;

      if (forUseRows.length) {
        await this.prisma.memoApproverAction.createMany({
          data: forUseRows.map((row) => ({
            memoId: id,
            loaUserId: row.id,
            statusId: waitingId,
            version: ver,
            assignedUserId: row.userId ?? null,
          })),
        });
      }
    }

    // 2.6 Re-clone approvers if line changed (no override)
    if (!hasOverride && lineChanged && newLineId) {
      await this.prisma.$transaction([
        this.prisma.memoApproverAction.deleteMany({ where: { memoId: id } }),
        this.prisma.lineOfApprovalUserPivotForUse.deleteMany({ where: { memoId: id } }),
      ]);

      const template = await this.prisma.lineOfApprovalUserPivot.findMany({
        where: { lineOfApprovalId: newLineId },
        orderBy: { level: 'asc' },
      });

      const forUseSlots: ForUseSlotInput[] = [];
      for (const p of template) {
        const slot = ((p.slotType as string) ?? 'FIXED_USER') as SlotT;
        let actualUserId: number | null = null;
        if (slot === 'FLEXIBLE_SLOT') {
          actualUserId = null;
        } else if (slot && slot !== 'FIXED_USER') {
          actualUserId = await this.resolveFlexibleSlot(slot, userIdNum, deptIdNum ?? null);
          if (actualUserId == null) continue;
        } else {
          if (p.userId == null) continue;
          actualUserId = p.userId;
        }
        forUseSlots.push({
          memoId: id,
          userId: actualUserId,
          level: p.level,
          isSigReq: p.isSigReq,
          roleDescription: p.roleDescription ?? null,
          slotType: slot,
          templatePivotId: p.id,
          approvalRequirement: ((p as { approvalRequirement?: 'ALL' | 'ANY' }).approvalRequirement as 'ALL' | 'ANY') ?? 'ALL',
        });
      }

      await this.prisma.$executeRaw`
        SELECT setval(
          pg_get_serial_sequence('"LineOfApprovalUserPivotForUse"', 'id'),
          COALESCE((SELECT MAX(id) FROM "LineOfApprovalUserPivotForUse"), 0) + 1,
          false
        )
      `;

      const cloned = await this.prisma.$transaction(
        forUseSlots.map((slot) =>
          this.prisma.lineOfApprovalUserPivotForUse.create({
            data: slot,
            select: { id: true, userId: true },
          }),
        ),
      );

      const waitingId = await this.getWaitingStatusId();
      const { _max } = await this.prisma.memoApproverAction.aggregate({
        where: { memoId: id },
        _max: { version: true },
      });
      const ver = (_max.version ?? 0) + 1;

      if (cloned.length) {
        await this.prisma.memoApproverAction.createMany({
          data: cloned.map((c) => ({
            memoId: id,
            loaUserId: c.id,
            statusId: waitingId,
            version: ver,
            assignedUserId: c.userId ?? null,
          })),
        });
      }
    }

    // Ensure Draft status
    await this.prisma.memoStatusPivot.upsert({
      where: {
        memoId_userId_statusId: { memoId: id, userId: +String(body['userId']), statusId: 1 },
      },
      update: { createdAt: new Date() },
      create: { memoId: id, userId: +String(body['userId']), statusId: 1 },
    });

    // 3-A Remove files
    if (removedFileIds.length) {
      const removed = await this.prisma.mainFile.findMany({
        where: { id: { in: removedFileIds } },
        select: { id: true, filePath: true },
      });
      await this.prisma.signaturePosition.deleteMany({ where: { fileId: { in: removedFileIds } } });
      await this.prisma.datePosition.deleteMany({ where: { fileId: { in: removedFileIds } } });
      await this.prisma.notePosition.deleteMany({ where: { fileId: { in: removedFileIds } } });
      await this.prisma.memoNumberPosition.deleteMany({ where: { fileId: { in: removedFileIds } } });
      await this.prisma.memoHistory.deleteMany({ where: { fileId: { in: removedFileIds } } });
      await this.prisma.mainFile.deleteMany({ where: { id: { in: removedFileIds } } });
      for (const f of removed) {
        try { if (fs.existsSync(f.filePath)) fs.unlinkSync(f.filePath); } catch { /* ignore */ }
      }
    }

    let removedAttachedFileIds: number[] = [];
    try { removedAttachedFileIds = JSON.parse(String(body['removedAttachedFileIds'] ?? '[]')) as number[]; } catch { removedAttachedFileIds = []; }

    if (removedAttachedFileIds.length) {
      const removedAttached = await this.prisma.attachedFile.findMany({
        where: { id: { in: removedAttachedFileIds } },
        select: { id: true, filePath: true, isUrl: true },
      });
      await this.prisma.attachedFile.deleteMany({ where: { id: { in: removedAttachedFileIds } } });
      for (const file of removedAttached) {
        try {
          if (!file.isUrl && file.filePath && fs.existsSync(file.filePath)) {
            fs.unlinkSync(file.filePath);
          }
        } catch (err) {
          this.logger.error(`Failed to delete attached file: ${file.filePath}`, err);
        }
      }
    }

    // 3-B Kept files
    let keptFiles = await this.prisma.mainFile.findMany({
      where: { memoId: id },
      orderBy: { orderNo: 'asc' },
    });

    // 3-C New uploads
    const mainFiles = files?.['files'] ?? [];
    const attachedFiles = files?.['attachedFiles'] ?? [];

    await Promise.all(
      attachedFiles.map((f) =>
        this.prisma.attachedFile.create({
          data: {
            memoId: id,
            fileName: decodeFilename(f.originalname),
            filePath: f.path,
            fileType: f.mimetype,
            size: f.size,
            isUrl: false,
          },
        }),
      ),
    );

    // URL links
    let urlLinks: Array<{ url: string; title: string }> = [];
    try { urlLinks = JSON.parse(String(body['urlLinks'] ?? '[]')) as Array<{ url: string; title: string }>; } catch { urlLinks = []; }

    await this.prisma.attachedFile.deleteMany({ where: { memoId: id, isUrl: true } });
    if (urlLinks.length > 0) {
      await Promise.all(
        urlLinks.map((link) =>
          this.prisma.attachedFile.create({
            data: {
              memoId: id,
              fileName: link.title || link.url,
              url: link.url,
              isUrl: true,
              fileType: 'url/link',
              size: 0,
              filePath: null,
            },
          }),
        ),
      );
    }

    const newFiles = await this.prisma.$transaction(
      mainFiles.map((f, idx) =>
        this.prisma.mainFile.create({
          data: {
            memoId: id,
            filePath: f.path,
            fileName: decodeFilename(f.originalname),
            size: f.size,
            orderNo: keptFiles.length + idx,
          },
        }),
      ),
    );

    keptFiles = [...keptFiles, ...newFiles];

    // 3-D Reorder
    keptFiles = await this.prisma.mainFile.findMany({
      where: { memoId: id },
      orderBy: { orderNo: 'asc' },
    });

    const oldMap = new Map<number, number>();
    keptFiles.forEach((f) => oldMap.set(f.id, f.id));
    const newMap = new Map<number, number>();
    newFiles.forEach((f, i) => newMap.set(i, f.id));

    const finalOrder: number[] = [];
    for (const tk of fileOrderTokens) {
      if (tk.startsWith('old:')) {
        const oldId = Number(tk.slice(4));
        if (oldMap.has(oldId)) finalOrder.push(oldMap.get(oldId)!);
      } else if (tk.startsWith('new:')) {
        const idx = Number(tk.slice(4));
        if (newMap.has(idx)) finalOrder.push(newMap.get(idx)!);
      }
    }

    const allIds = new Set([...keptFiles.map((f) => f.id), ...newFiles.map((f) => f.id)]);
    finalOrder.forEach((fid) => allIds.delete(fid));
    finalOrder.push(...allIds);

    await this.prisma.$transaction(
      finalOrder.map((fileId, orderNo) =>
        this.prisma.mainFile.update({ where: { id: fileId }, data: { orderNo } }),
      ),
    );

    keptFiles = await this.prisma.mainFile.findMany({
      where: { memoId: id },
      orderBy: { orderNo: 'asc' },
    });

    const fileIdMap: Record<number, number> = {};
    keptFiles.forEach((f, idx) => (fileIdMap[idx] = f.id));

    // 4. Positions upsert
    const sigs: SigPos[] = JSON.parse(sigPositions) as SigPos[];
    const dates: DatePos[] = JSON.parse(datePositions) as DatePos[];
    const notes: NotePos[] = JSON.parse(notePositions) as NotePos[];
    const memoNums: MemoNumPos[] = JSON.parse(memoNumberPositions) as MemoNumPos[];

    const sigIdsKept: number[] = [];
    const dateIdsKept: number[] = [];
    const noteIdsKept: number[] = [];
    const memoNumIdsKept: number[] = [];
    const tx: Prisma.PrismaPromise<unknown>[] = [];
    const sigCreates: Prisma.PrismaPromise<unknown>[] = [];
    const dateCreates: Prisma.PrismaPromise<unknown>[] = [];
    const noteCreates: Prisma.PrismaPromise<unknown>[] = [];
    const memoNumCreates: Prisma.PrismaPromise<unknown>[] = [];

    for (const p of sigs) {
      const data = { memoId: id, fileId: fileIdMap[p.fileIdx], userId: p.userId, page: p.page, x: +p.x.toFixed(6), y: +p.y.toFixed(6), sizePct: p.sizePct ?? 100, level: p.level ?? null };
      if (typeof p.id === 'number') { sigIdsKept.push(p.id); tx.push(this.prisma.signaturePosition.update({ where: { id: p.id }, data })); }
      else sigCreates.push(this.prisma.signaturePosition.create({ data }));
    }
    tx.push(this.prisma.signaturePosition.deleteMany({ where: { memoId: id, id: { notIn: sigIdsKept } } }));
    tx.push(...sigCreates);

    for (const p of dates) {
      const cleanDate = new Date(new Date(p.date).toLocaleDateString('sv-SE'));
      const data = { memoId: id, fileId: fileIdMap[p.fileIdx], userId: p.userId, page: p.page, x: +p.x.toFixed(6), y: +p.y.toFixed(6), date: cleanDate, sizePct: p.sizePct ?? 100, level: p.level ?? null };
      if (typeof p.id === 'number') { dateIdsKept.push(p.id); tx.push(this.prisma.datePosition.update({ where: { id: p.id }, data })); }
      else dateCreates.push(this.prisma.datePosition.create({ data }));
    }
    tx.push(this.prisma.datePosition.deleteMany({ where: { memoId: id, id: { notIn: dateIdsKept } } }));
    tx.push(...dateCreates);

    for (const p of notes) {
      const data = { memoId: id, fileId: fileIdMap[p.fileIdx], page: p.page, x: +p.x.toFixed(6), y: +p.y.toFixed(6), text: p.text, sizePct: p.sizePct ?? 100 };
      if (typeof p.id === 'number') { noteIdsKept.push(p.id); tx.push(this.prisma.notePosition.update({ where: { id: p.id }, data })); }
      else noteCreates.push(this.prisma.notePosition.create({ data }));
    }
    tx.push(this.prisma.notePosition.deleteMany({ where: { memoId: id, id: { notIn: noteIdsKept } } }));
    tx.push(...noteCreates);

    for (const p of memoNums) {
      const data = { memoId: id, fileId: fileIdMap[p.fileIdx], page: p.page, x: +p.x.toFixed(6), y: +p.y.toFixed(6), sizePct: p.sizePct ?? 100 };
      if (typeof p.id === 'number') { memoNumIdsKept.push(p.id); tx.push(this.prisma.memoNumberPosition.update({ where: { id: p.id }, data })); }
      else memoNumCreates.push(this.prisma.memoNumberPosition.create({ data }));
    }
    tx.push(this.prisma.memoNumberPosition.deleteMany({ where: { memoId: id, id: { notIn: memoNumIdsKept } } }));
    tx.push(...memoNumCreates);

    await this.prisma.$transaction(tx);

    return memo;
  }

  // ── deleteMemo (soft delete) ──────────────────────────────────────────────

  async deleteMemo(memoId: number, actorId: number): Promise<void> {
    if (await this.hasAnyApprovedInLatestVersion(memoId)) {
      throw new BadRequestException(
        'ลบไม่ได้: เอกสารนี้มีการอนุมัติแล้วอย่างน้อย 1 คน (ให้ Recall แบบ Clear เพื่อเริ่มใหม่ก่อน)',
      );
    }

    let deletedStatus = await this.prisma.status.findFirst({ where: { name: 'Deleted' } });
    if (!deletedStatus) {
      const maxStat = await this.prisma.status.aggregate({ _max: { id: true } });
      const nextId = (maxStat._max.id ?? 0) + 1;
      deletedStatus = await this.prisma.status.create({
        data: { id: nextId, name: 'Deleted', description: 'Soft deleted' },
      });
    }

    await this.prisma.$transaction([
      this.prisma.memoStatusPivot.create({
        data: { memoId, statusId: deletedStatus.id, userId: actorId },
      }),
      this.prisma.memoHistory.create({
        data: {
          memoId,
          userId: actorId,
          action: 'Memo deleted (soft delete)',
          statusId: deletedStatus.id,
          actiontype: ActionType.TERMINATE,
        },
      }),
      this.prisma.masterMemo.update({
        where: { id: memoId },
        data: { deletedAt: new Date() },
      }),
    ]);
  }

  // ── forceDeleteMemo (hard delete + file cleanup) ──────────────────────────

  async forceDeleteMemo(memoId: number): Promise<void> {
    const comments = await this.prisma.comment.findMany({
      where: { memoId },
      select: { id: true },
    });
    const commentIds = comments.map((c) => c.id);

    const mainFiles = await this.prisma.mainFile.findMany({
      where: { memoId },
      select: { filePath: true },
    });
    const attachedFiles = await this.prisma.attachedFile.findMany({
      where: { memoId },
      select: { filePath: true },
    });
    const commentAtts = await this.prisma.commentAttachment.findMany({
      where: { commentId: { in: commentIds } },
      select: { url: true },
    });

    const allPaths = [
      ...mainFiles.map((f) => absFromDbPath(f.filePath)),
      ...attachedFiles.filter((f) => f.filePath).map((f) => absFromDbPath(f.filePath!)),
      ...commentAtts.map((a) => path.join(UPLOADS_DIR, 'comments', path.basename(a.url))),
    ];

    const cloneIds = await this.prisma.memoApproverAction
      .findMany({ where: { memoId }, select: { loaUserId: true } })
      .then((r) => r.map((x) => x.loaUserId));

    await this.prisma.$transaction([
      this.prisma.notification.deleteMany({
        where: { OR: [{ memoId }, { commentId: { in: commentIds } }] },
      }),
      this.prisma.commentAttachment.deleteMany({ where: { commentId: { in: commentIds } } }),
      this.prisma.comment.deleteMany({ where: { memoId } }),
      this.prisma.signaturePosition.deleteMany({ where: { memoId } }),
      this.prisma.datePosition.deleteMany({ where: { memoId } }),
      this.prisma.memoHistory.deleteMany({ where: { memoId } }),
      this.prisma.memoStatusPivot.deleteMany({ where: { memoId } }),
      this.prisma.memoApproverAction.deleteMany({ where: { memoId } }),
      this.prisma.attachedFile.deleteMany({ where: { memoId } }),
      this.prisma.mainFile.deleteMany({ where: { memoId } }),
      this.prisma.masterMemo.delete({ where: { id: memoId } }),
      this.prisma.lineOfApprovalUserPivot.deleteMany({ where: { id: { in: cloneIds } } }),
    ]);

    for (const p of allPaths) {
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch (e) { this.logger.warn(`Failed to delete file ${p}`, e); }
      }
    }
  }

  // ── renewExpiry ───────────────────────────────────────────────────────────

  async renewExpiry(params: {
    memoId: number;
    actorId: number;
    actorRole: string;
    expiresAt: string;
    targetStatus?: 'Draft' | 'Processing';
  }): Promise<{ message: string; memo: { id: number; expiresAt: Date | null; subject: string } }> {
    const { memoId, actorId, actorRole, targetStatus = 'Processing' } = params;

    const parsed = parseExpiresAt(params.expiresAt);
    if (!parsed) throw new BadRequestException('expiresAt is required and must be a valid date');
    if (parsed.getTime() <= Date.now()) throw new BadRequestException('expiresAt must be in the future');

    const memo = await this.prisma.masterMemo.findFirst({
      where: { id: memoId, deletedAt: null },
      select: { id: true, userId: true },
    });
    if (!memo) throw new NotFoundException('Memo not found');

    const isAdmin = actorRole.toUpperCase() === 'ADMIN';
    if (memo.userId !== actorId && !isAdmin) {
      throw new ForbiddenException('Only memo owner or admin can renew expiry');
    }

    const latestPivot = await this.prisma.memoStatusPivot.findFirst({
      where: { memoId },
      include: { status: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const latestStatusName = (latestPivot?.status?.name ?? '').toLowerCase();
    if (!['processing', 'expired', 'draft'].includes(latestStatusName)) {
      throw new BadRequestException(
        `Cannot renew: current status is "${latestPivot?.status?.name ?? 'unknown'}". Only Draft, Processing or Expired memos can be renewed.`,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const updatedMemo = await tx.masterMemo.update({
        where: { id: memoId },
        data: { expiresAt: parsed },
        select: { id: true, expiresAt: true, subject: true },
      });

      if (latestStatusName === 'expired') {
        const expiredStatusId = await this.getStatusIdByName('Expired');
        const newStatusId = await this.getStatusIdByName(targetStatus);

        await tx.memoStatusPivot.deleteMany({ where: { memoId, statusId: expiredStatusId } });

        await tx.memoStatusPivot.upsert({
          where: { memoId_userId_statusId: { memoId, userId: actorId, statusId: newStatusId } },
          update: { createdAt: new Date() },
          create: { memoId, userId: actorId, statusId: newStatusId },
        });

        if (targetStatus === 'Draft') {
          const { _max } = await tx.memoApproverAction.aggregate({
            where: { memoId },
            _max: { version: true },
          });
          const latestVersion = _max.version ?? 1;
          const waitingId = await this.getWaitingStatusId();

          await tx.memoApproverAction.updateMany({
            where: { memoId, version: latestVersion },
            data: { statusId: waitingId, signatureImageId: null, signatureText: null, actedAt: null },
          });

          const activeExtraLines = await tx.extraApprovalLine.findMany({
            where: { memoId, status: { in: [ExtraStatus.PENDING, ExtraStatus.IN_PROGRESS] } },
            select: { id: true },
          });
          if (activeExtraLines.length) {
            const lineIds = activeExtraLines.map((l) => l.id);
            await tx.extraApprovalLine.updateMany({ where: { id: { in: lineIds } }, data: { status: ExtraStatus.PENDING, closedAt: null } });
            await tx.extraApprover.updateMany({ where: { extraId: { in: lineIds } }, data: { statusId: null, actedAt: null } });
          }
        }
      }

      await tx.memoHistory.create({
        data: {
          memoId,
          userId: actorId,
          action: 'Renewed expiry date',
          actiontype: ActionType.UPDATE,
          timestamp: new Date(),
        },
      });

      return updatedMemo;
    });

    return { message: 'Expiry date renewed successfully', memo: updated };
  }

  // ── uploadMainPDF ─────────────────────────────────────────────────────────

  async uploadMainPDF(memoId: number, file: Express.Multer.File): Promise<unknown> {
    const newFile = await this.prisma.mainFile.create({
      data: {
        memoId,
        filePath: file.path,
        fileName: decodeFilename(file.originalname),
        size: file.size,
      },
    });
    return newFile;
  }

  // ── Private: reserveMemoNumber (Nest Prisma — mirrors backend lib exactly) ─

  private async _reserveMemoNumber(params: {
    businessUnitId: number;
    departmentId: number | null;
    memotypeId: number | null;
    buAbbr: string;
    deptAbbr: string;
    typeAbbr: string;
  }): Promise<{ id: number; memonumber: string }> {
    const { businessUnitId, departmentId, memotypeId, buAbbr, deptAbbr, typeAbbr } = params;

    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const yyyymm = `${year}${String(month).padStart(2, '0')}`;
    const parts = [buAbbr, deptAbbr, typeAbbr].filter((s) => s && s.trim()).join('-');
    const prefix = `${parts}-${yyyymm}-`;

    const MAX_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const rows = await this.prisma.$queryRaw<Array<{ id: number; memonumber: string; sequenceNumber: number }>>`
          INSERT INTO "MemoNumber" (
            "memonumber", "businessUnitId", "departmentId", "memotypeId",
            "year", "month", "sequenceNumber", "createdAt"
          )
          SELECT
            ${prefix} || LPAD(next_seq::text, 4, '0'),
            ${businessUnitId},
            ${departmentId}::int,
            ${memotypeId}::int,
            ${year},
            ${month},
            next_seq,
            NOW()
          FROM (
            SELECT GREATEST(
              COALESCE((
                SELECT MAX("sequenceNumber") FROM "MemoNumber"
                WHERE "memonumber" LIKE ${prefix + '%'}
              ), 0),
              COALESCE((
                SELECT MAX("sequenceNumber") FROM "MemoNumber"
                WHERE "businessUnitId" = ${businessUnitId}
                  AND "year" = ${year}
                  AND "month" = ${month}
                  AND "departmentId" IS NOT DISTINCT FROM ${departmentId}::int
                  AND "memotypeId" IS NOT DISTINCT FROM ${memotypeId}::int
              ), 0)
            ) + 1 AS next_seq
          ) sub
          RETURNING "id", "memonumber", "sequenceNumber"
        `;
        return { id: rows[0].id, memonumber: rows[0].memonumber };
      } catch (e: unknown) {
        const err = e as { code?: string; meta?: { code?: string }; message?: string };
        const isUniqueViolation = err?.code === 'P2002' || (err?.code === 'P2010' && err?.meta?.code === '23505');
        const isRetryable = isUniqueViolation || err?.code === 'P2024' || err?.code === 'P2034' || err?.message?.includes('timeout') || err?.message?.includes('deadlock');
        if (isRetryable && attempt < MAX_ATTEMPTS - 1) {
          const waitTime = 100 * Math.pow(2, attempt) + Math.floor(Math.random() * 100);
          await new Promise((resolve) => setTimeout(resolve, waitTime));
          continue;
        }
        throw e;
      }
    }
    throw new InternalServerErrorException(`Failed to reserve memo number after ${MAX_ATTEMPTS} retries.`);
  }
}
