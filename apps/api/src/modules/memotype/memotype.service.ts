/**
 * MemotypeService
 *
 * Mirrors backend/src/controllers/memotype.controller.ts exactly.
 *
 * Key points:
 *   - File upload: uses in-memory multer (FileInterceptor), writes buffer to disk
 *     at UPLOADS_DIR/types/ (same directory as Express).
 *   - Filename handling: decodeFilename (latin1→utf8) + sanitizeName from upload.config
 *     (mirrors safeFileName + decodeFilename in Express backend/src/lib/filename.ts).
 *   - Transaction: createMEMOType creates lineOfApproval + lineOfApprovalUserPivot
 *     atomically with memoType.  updateMEMOType rewrites pivots in same tx.
 *   - File duplication: when duplicateFromId is provided, copies physical files.
 *   - Path traversal: UPLOADS_DIR prefix check before file ops.
 *
 * Security (คุณอิเอริ):
 *   - File type validated by Express middleware (ALLOWED_DOC_EXTS/ALLOWED_DOC_MIMES).
 *   - sanitizeName strips dangerous characters from all filenames.
 *   - toLocalPath() enforces UPLOADS_DIR boundary before unlink.
 *   - No user-controlled absolute paths accepted.
 */

import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminLogService } from '../../common/admin-log/admin-log.service';
import { JwtPayload } from '../../common/guards/jwt.guard';
import { UPLOADS_DIR, sanitizeName } from '../../common/upload/upload.config';
import { Prisma, ApprovalSlotType, ApprovalRequirement } from '@prisma/client';

// ---------------------------------------------------------------------------
// Helpers (mirrored from Express)
// ---------------------------------------------------------------------------

/** Mirrors backend/src/lib/filename.ts decodeFilename */
function decodeFilename(name: string): string {
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch {
    return name;
  }
}

/** Mirrors backend/src/lib/filename.ts safeFileName, using sanitizeName as base */
function safeFileName(name: string, max = 180): string {
  return name
    .replace(/[\r\n]/g, ' ')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const normalizeOptionalId = (raw: unknown): number | undefined => {
  if (raw === undefined || raw === null || raw === '' || raw === 'null') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

const parseBool = (v: unknown): boolean | undefined => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return undefined;
};

function hasRole(user: JwtPayload, target: string): boolean {
  const primary = (user?.role ?? '').toString().toUpperCase();
  if (primary === target) return true;
  return ((user as any)?.roles ?? []).some((r: string) => (r ?? '').toUpperCase() === target);
}

function isAdmin(user: JwtPayload): boolean {
  return hasRole(user, 'ADMIN');
}

function isDcc(user: JwtPayload): boolean {
  return hasRole(user, 'DCC');
}

function isAdminOrDcc(user: JwtPayload): boolean {
  return isAdmin(user) || isDcc(user);
}

/** Path traversal guard: ensure localPath stays under UPLOADS_DIR */
function toLocalPath(webPath: string): string {
  const normalized = webPath.replace(/\\/g, '/');
  const rest = normalized.replace(/^\/?uploads\//, '');
  const safeRest = rest
    .split('/')
    .filter((seg) => seg && seg !== '..')
    .join(path.sep);
  return path.join(UPLOADS_DIR, safeRest);
}

// ---------------------------------------------------------------------------
// Approval levels formatting (for getAllMEMOTypes)
// ---------------------------------------------------------------------------

function buildApprovalLevels(pivots: Array<{
  id: number;
  level: number;
  isSigReq: boolean;
  slotType: string | null;
  roleDescription: string | null;
  approvalRequirement: string | null;
  user: { id: number; name: string; lastname: string | null; nickname: string | null } | null;
}>) {
  const map: Record<number, unknown[]> = {};
  for (const p of pivots) {
    if (p.slotType === 'FIXED_USER' && p.user) {
      (map[p.level] ||= []).push({
        id: p.user.id,
        loaUserPivotId: p.id,
        name: p.user.name,
        lastname: p.user.lastname,
        nickname: p.user.nickname,
        isSigReq: !!p.isSigReq,
        slotType: p.slotType,
        roleDescription: p.roleDescription,
        approvalRequirement: p.approvalRequirement,
      });
    } else if (p.slotType && p.slotType !== 'FIXED_USER') {
      (map[p.level] ||= []).push({
        id: null,
        loaUserPivotId: p.id,
        name: null,
        lastname: null,
        nickname: null,
        displayName: p.roleDescription || p.slotType,
        isSigReq: !!p.isSigReq,
        slotType: p.slotType,
        roleDescription: p.roleDescription,
        approvalRequirement: p.approvalRequirement,
      });
    }
  }
  return Object.keys(map)
    .map((k) => ({ level: Number(k), users: map[Number(k)] }))
    .sort((a, b) => a.level - b.level);
}

// ---------------------------------------------------------------------------
// Visibility where clause (mirrors Express buildVisibilityWhere)
// ---------------------------------------------------------------------------

@Injectable()
export class MemotypeService {
  private readonly logger = new Logger(MemotypeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adminLog: AdminLogService,
  ) {}

  private async buildVisibilityWhere(
    user: JwtPayload,
    businsessUnitIdQuery?: number | null,
    includeInactive = false,
    context: 'creation' | 'management' = 'creation',
  ): Promise<Prisma.MemoTypeWhereInput> {
    if (isAdmin(user)) {
      return includeInactive ? {} : { isActive: true };
    }

    if (isDcc(user)) {
      const dccUser = await this.prisma.user.findUnique({
        where: { id: user.id },
        select: {
          businessUnitId: true,
          departmentId: true,
          businessUnitAccess: { select: { businessUnitId: true } },
          dccManagementAccess: { select: { businessUnitId: true } },
        },
      });

      const dccBuId = dccUser?.businessUnitId ?? null;
      const dccDeptId = dccUser?.departmentId ?? null;

      let accessibleBuIds: number[];
      if (context === 'management') {
        const dccMgmtBuIds = (dccUser?.dccManagementAccess || []).map((a) => a.businessUnitId);
        accessibleBuIds = dccBuId
          ? [dccBuId, ...dccMgmtBuIds.filter((id) => id !== dccBuId)]
          : dccMgmtBuIds;
      } else {
        const additionalBuIds = (dccUser?.businessUnitAccess || []).map((a) => a.businessUnitId);
        accessibleBuIds = dccBuId
          ? [dccBuId, ...additionalBuIds.filter((id) => id !== dccBuId)]
          : additionalBuIds;
      }

      if (businsessUnitIdQuery && accessibleBuIds.includes(businsessUnitIdQuery)) {
        const hiddenFilter = context === 'creation' ? { isDelete: false } : {};
        return includeInactive
          ? { businessUnitId: businsessUnitIdQuery, ...hiddenFilter }
          : { isActive: true, businessUnitId: businsessUnitIdQuery, ...hiddenFilter };
      }

      if (context === 'creation') {
        const OR: Prisma.MemoTypeWhereInput[] = [{ forEveryone: true }];
        if (accessibleBuIds.length > 0) {
          OR.push({
            AND: [
              { forAllDepartmentUnderSelectedBu: true },
              { businessUnitId: { in: accessibleBuIds } },
            ],
          });
        }
        if (dccDeptId != null) {
          OR.push({ AND: [{ forEveryDepartmentAcrossBU: true }, { departmentId: dccDeptId }] });
        }
        if (accessibleBuIds.length > 0 && dccDeptId != null) {
          OR.push({
            AND: [
              { forEveryone: false },
              { forEveryDepartmentAcrossBU: false },
              { forAllDepartmentUnderSelectedBu: false },
              { businessUnitId: { in: accessibleBuIds } },
              { departmentId: dccDeptId },
            ],
          });
        }
        return { isActive: true, isDelete: false, OR };
      }

      // management context
      const OR: Prisma.MemoTypeWhereInput[] = [];
      if (accessibleBuIds.length > 0) {
        OR.push({ businessUnitId: { in: accessibleBuIds } });
      }
      OR.push({ forEveryone: true });
      if (OR.length === 1) {
        return includeInactive ? { forEveryone: true } : { forEveryone: true, isActive: true };
      }
      return includeInactive ? { OR } : { isActive: true, OR };
    }

    // Regular user
    if (!user?.id) {
      return { forEveryone: true, isActive: true, isDelete: false };
    }

    const me = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: {
        businessUnitId: true,
        departmentId: true,
        businessUnitAccess: { select: { businessUnitId: true } },
      },
    });

    const myBuId = me?.businessUnitId ?? null;
    const myDeptId = me?.departmentId ?? null;
    const additionalBuIds = (me?.businessUnitAccess || []).map((a) => a.businessUnitId);
    const allAccessibleBuIds = myBuId
      ? [myBuId, ...additionalBuIds.filter((id) => id !== myBuId)]
      : additionalBuIds;

    const OR: Prisma.MemoTypeWhereInput[] = [{ forEveryone: true }];
    if (allAccessibleBuIds.length > 0) {
      OR.push({
        AND: [
          { forAllDepartmentUnderSelectedBu: true },
          { businessUnitId: { in: allAccessibleBuIds } },
        ],
      });
    }
    if (myDeptId != null) {
      OR.push({ AND: [{ forEveryDepartmentAcrossBU: true }, { departmentId: myDeptId }] });
    }
    if (allAccessibleBuIds.length > 0 && myDeptId != null) {
      OR.push({
        AND: [
          { forEveryone: false },
          { forEveryDepartmentAcrossBU: false },
          { forAllDepartmentUnderSelectedBu: false },
          { businessUnitId: { in: allAccessibleBuIds } },
          { departmentId: myDeptId },
        ],
      });
    }

    const baseWhere = { isActive: true, OR };
    if (context === 'creation') {
      return { ...baseWhere, isDelete: false };
    }
    return baseWhere;
  }

  // ---------------------------------------------------------------------------
  // GET /api/memotypes/count
  // ---------------------------------------------------------------------------

  async getCount(user: JwtPayload) {
    const where = await this.buildVisibilityWhere(user);
    const [activeCount, totalCount] = await Promise.all([
      this.prisma.memoType.count({ where: { ...where, isActive: true } }),
      this.prisma.memoType.count({ where }),
    ]);
    return { activeCount, totalCount };
  }

  // ---------------------------------------------------------------------------
  // GET /api/memotypes
  // ---------------------------------------------------------------------------

  async findAll(
    user: JwtPayload,
    includeInactive: boolean,
    context: 'creation' | 'management',
    businessUnitIdQuery?: number | null,
  ) {
    const where = await this.buildVisibilityWhere(user, businessUnitIdQuery, includeInactive, context);

    const types = await this.prisma.memoType.findMany({
      where,
      select: {
        id: true,
        name: true,
        description: true,
        abbreviation: true,
        isActive: true,
        isDelete: true,
        createdAt: true,
        defaultTypeFileId: true,
        businessUnitId: true,
        approvalLineId: true,
        forEveryone: true,
        forEveryDepartmentAcrossBU: true,
        forAllDepartmentUnderSelectedBu: true,
        departmentId: true,
        department: { select: { id: true, name: true } },
        businessUnit: { select: { id: true, name: true } },
        approvalLine: { select: { id: true, name: true } },
        typeFiles: {
          select: { id: true, fileName: true, filePath: true, size: true, orderNo: true },
          orderBy: { orderNo: 'asc' },
        },
      },
      orderBy: { name: 'asc' },
    });

    // Enrich with approval levels
    for (const type of types) {
      if ((type as any).approvalLineId) {
        const pivots = await this.prisma.lineOfApprovalUserPivot.findMany({
          where: { lineOfApprovalId: (type as any).approvalLineId },
          select: {
            id: true,
            level: true,
            isSigReq: true,
            slotType: true,
            roleDescription: true,
            approvalRequirement: true,
            user: { select: { id: true, name: true, lastname: true, nickname: true } },
          },
        });
        (type as any).approvalLevels = buildApprovalLevels(pivots as any);
      }
    }

    return types;
  }

  // ---------------------------------------------------------------------------
  // GET /api/memotypes/:id
  // ---------------------------------------------------------------------------

  async findById(user: JwtPayload, id: number, context: 'creation' | 'management', includeDeleted: boolean) {
    let visibilityWhere = await this.buildVisibilityWhere(user, null, false, context);

    if (includeDeleted) {
      const { isActive, isDelete, ...restWhere } = visibilityWhere as any;
      visibilityWhere = restWhere;
    }

    const type = await this.prisma.memoType.findFirst({
      where: { AND: [{ id }, visibilityWhere] },
      select: {
        id: true,
        name: true,
        description: true,
        abbreviation: true,
        isActive: true,
        isDelete: true,
        createdAt: true,
        updatedAt: true,
        defaultTypeFileId: true,
        businessUnitId: true,
        approvalLineId: true,
        forEveryone: true,
        forEveryDepartmentAcrossBU: true,
        forAllDepartmentUnderSelectedBu: true,
        departmentId: true,
        department: { select: { id: true, name: true } },
        businessUnit: { select: { id: true, name: true } },
        approvalLine: { select: { id: true, name: true } },
        typeFiles: {
          select: { id: true, fileName: true, filePath: true, size: true, orderNo: true },
          orderBy: { orderNo: 'asc' },
        },
      },
    });

    if (!type) {
      throw new ForbiddenException('You do not have permission to view this type');
    }

    if ((type as any).approvalLineId) {
      const pivots = await this.prisma.lineOfApprovalUserPivot.findMany({
        where: { lineOfApprovalId: (type as any).approvalLineId },
        select: {
          id: true,
          level: true,
          isSigReq: true,
          slotType: true,
          roleDescription: true,
          approvalRequirement: true,
          user: { select: { id: true, name: true, lastname: true, nickname: true } },
        },
      });
      (type as any).approvalLevels = buildApprovalLevels(pivots as any);
    }

    return type;
  }

  // ---------------------------------------------------------------------------
  // POST /api/memotypes
  // ---------------------------------------------------------------------------

  async createMEMOType(user: JwtPayload, body: Record<string, unknown>, files: Express.Multer.File[]) {
    const name = (body['name'] as string | undefined)?.toString?.() ?? '';
    const description = (body['description'] as string | undefined)?.toString?.() ?? '';
    const abbreviation = (body['abbreviation'] as string | undefined)?.toString?.() ?? '';
    const isActiveRaw = body['isActive'];
    const buIdNorm = normalizeOptionalId(body['businessUnitId']);
    const depIdNorm = normalizeOptionalId(body['departmentId']);
    const fe = parseBool(body['forEveryone']) ?? false;
    const fac = parseBool(body['forEveryDepartmentAcrossBU']) ?? false;
    const fbu = parseBool(body['forAllDepartmentUnderSelectedBu']) ?? false;
    const duplicateFromId = normalizeOptionalId(body['duplicateFromId']);

    if ('id' in body) delete (body as any)['id'];

    const numTrue = [fe, fac, fbu].filter(Boolean).length;
    if (numTrue > 1) {
      throw new BadRequestException(
        'Only one of {forEveryone, forEveryDepartmentAcrossBU, forAllDepartmentUnderSelectedBu} can be true',
      );
    }
    const isNoMode = numTrue === 0;

    if (!fe && buIdNorm == null) {
      throw new BadRequestException('businessUnitId is required');
    }
    if (fac && depIdNorm == null) {
      throw new BadRequestException('departmentId is required when forEveryDepartmentAcrossBU is true');
    }
    if (isNoMode && depIdNorm == null) {
      throw new BadRequestException('departmentId is required when forAllDepartmentUnderSelectedBu is false');
    }

    if (depIdNorm != null) {
      const dep = await this.prisma.department.findUnique({
        where: { id: depIdNorm },
        select: { id: true },
      });
      if (!dep) throw new BadRequestException('Department not found');
    }

    const buToWrite = fe ? null : fbu ? (buIdNorm as number) : isNoMode ? (buIdNorm as number) : undefined;

    if (!name || !description) {
      throw new BadRequestException('Missing required fields');
    }
    if (!user?.id) {
      throw new ForbiddenException('Missing user in token');
    }

    if (buIdNorm !== undefined) {
      const bu = await this.prisma.businessUnit.findUnique({
        where: { id: buIdNorm },
        select: { id: true },
      });
      if (!bu) throw new BadRequestException('Business Unit not found');
    }

    const isActive = parseBool(isActiveRaw);
    const isDelete = parseBool(body['isDelete']) ?? false;

    const wantLineUsers =
      String((body['createApprovalLine'] as any) ?? '').toLowerCase() === 'true';

    let levels: Array<{
      approvalRequirement?: string;
      users: Array<{
        id?: number | null;
        isSigReq?: boolean;
        slotType?: string;
        roleDescription?: string | null;
        approvalRequirement?: string;
      }>;
    }> = [];
    if (wantLineUsers) {
      let raw = body['approvalLevels'] as string | string[] | undefined;
      if (Array.isArray(raw)) raw = raw[0];
      if (typeof raw === 'string' && raw.trim() !== '') {
        try {
          levels = JSON.parse(raw);
        } catch {
          throw new BadRequestException('Invalid JSON in approvalLevels');
        }
      }
    }

    // ── Transaction: create memoType + lineOfApproval + pivot ──────────────
    const { createdType } = await this.prisma.$transaction(async (tx) => {
      const t = await tx.memoType.create({
        data: {
          name,
          description,
          abbreviation,
          createdByUserId: user.id,
          ...(isActive !== undefined ? { isActive } : {}),
          isDelete,
          ...(buToWrite !== undefined ? { businessUnitId: buToWrite } : {}),
          departmentId: depIdNorm ?? null,
          forEveryone: fe,
          forEveryDepartmentAcrossBU: fac,
          forAllDepartmentUnderSelectedBu: fbu,
        },
        select: {
          id: true,
          name: true,
          description: true,
          abbreviation: true,
          isActive: true,
          isDelete: true,
          createdAt: true,
          updatedAt: true,
          createdByUserId: true,
          defaultTypeFileId: true,
          departmentId: true,
          department: { select: { id: true, name: true } },
          businessUnit: { select: { id: true, name: true } },
        },
      });

      const line = await tx.lineOfApproval.create({
        data: {
          name,
          userId: user.id,
          businessUnitId: buToWrite ?? null,
        },
        select: { id: true },
      });

      if (wantLineUsers && Array.isArray(levels) && levels.length > 0) {
        for (let lvIdx = 0; lvIdx < levels.length; lvIdx++) {
          const lv = levels[lvIdx];
          const seenInLevel = new Set<number>();
          for (const u of lv.users ?? []) {
            if (u.slotType === 'FIXED_USER') {
              if (!u.id) throw new Error(`FIXED_USER slot at Level ${lvIdx + 1} requires a valid user ID`);
              const uid = Number(u.id);
              if (!Number.isFinite(uid) || uid <= 0) throw new Error(`Invalid user ID at Level ${lvIdx + 1}`);
              if (seenInLevel.has(uid)) throw new Error(`Duplicate approver at the same level (Level ${lvIdx + 1})`);
              seenInLevel.add(uid);
            }
          }
        }

        const rows: Prisma.LineOfApprovalUserPivotCreateManyInput[] = [];
        levels.forEach((lv, lvIdx) => {
          (lv.users || []).forEach((u) => {
            let userId: number | null = null;
            if (u.slotType === 'FIXED_USER' && u.id != null) {
              const parsedId = Number(u.id);
              if (Number.isFinite(parsedId) && parsedId > 0) userId = parsedId;
            }
            rows.push({
              lineOfApprovalId: line.id,
              userId,
              level: lvIdx,
              isSigReq: !!u.isSigReq,
              slotType: (u.slotType || 'FIXED_USER') as ApprovalSlotType,
              roleDescription: u.roleDescription ?? null,
              approvalRequirement: (u.approvalRequirement || lv.approvalRequirement || 'ALL') as ApprovalRequirement,
            });
          });
        });

        if (rows.length > 0) {
          await tx.lineOfApprovalUserPivot.createMany({ data: rows });
        }
      }

      await tx.memoType.update({
        where: { id: t.id },
        data: { approvalLineId: line.id },
      });

      return { createdType: t };
    });

    // ── ATTACH FILES ──────────────────────────────────────────────────────────
    let createdFiles: { id: number; orderNo: number }[] = [];

    // File duplication
    if (duplicateFromId) {
      const originalFiles = await this.prisma.typeFile.findMany({
        where: { memoTypeId: duplicateFromId },
        orderBy: { orderNo: 'asc' },
        select: { id: true, fileName: true, filePath: true, size: true, orderNo: true },
      });

      if (originalFiles.length > 0) {
        const typeDir = path.join(UPLOADS_DIR, 'types');
        fs.mkdirSync(typeDir, { recursive: true });

        for (let idx = 0; idx < originalFiles.length; idx++) {
          const originalFile = originalFiles[idx];
          try {
            const originalPath = toLocalPath(originalFile.filePath);
            if (originalPath.startsWith(UPLOADS_DIR) && fs.existsSync(originalPath)) {
              const fileBuffer = fs.readFileSync(originalPath);
              const timestamp = Date.now();
              const ext = path.extname(originalFile.fileName);
              const baseName = path.basename(originalFile.fileName, ext);
              const newFileName = `${timestamp}_${idx}_${baseName}_copy${ext}`;
              fs.writeFileSync(path.join(typeDir, newFileName), fileBuffer);

              const created = await this.prisma.typeFile.create({
                data: {
                  memoTypeId: createdType.id,
                  filePath: `/uploads/types/${newFileName}`,
                  fileName: originalFile.fileName,
                  size: originalFile.size,
                  orderNo: idx,
                },
                select: { id: true, orderNo: true },
              });
              createdFiles.push(created);
            }
          } catch (error) {
            this.logger.warn(`Failed to duplicate file ${originalFile.fileName}`, error);
          }
        }
      }
    }

    // New uploaded files
    if (files.length > 0) {
      const typeDir = path.join(UPLOADS_DIR, 'types');
      fs.mkdirSync(typeDir, { recursive: true });
      const startOrder = createdFiles.length;

      for (let idx = 0; idx < files.length; idx++) {
        const f = files[idx];
        const original = safeFileName(decodeFilename(f.originalname || `file_${idx}`));
        const base = `${Date.now()}_${idx}_${original}`;
        fs.writeFileSync(path.join(typeDir, base), f.buffer);

        const created = await this.prisma.typeFile.create({
          data: {
            memoTypeId: createdType.id,
            filePath: `/uploads/types/${base}`,
            fileName: decodeFilename(f.originalname || `file_${idx}`),
            size: f.size ?? 0,
            orderNo: startOrder + idx,
          },
          select: { id: true, orderNo: true },
        });
        createdFiles.push(created);
      }
    }

    const full = await this.prisma.memoType.findUnique({
      where: { id: createdType.id },
      select: {
        id: true,
        name: true,
        description: true,
        abbreviation: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        createdByUserId: true,
        defaultTypeFileId: true,
        approvalLineId: true,
        departmentId: true,
        department: { select: { id: true, name: true } },
        businessUnit: { select: { id: true, name: true } },
        approvalLine: { select: { id: true, name: true } },
        typeFiles: {
          select: { id: true, fileName: true, filePath: true, size: true, orderNo: true },
          orderBy: { orderNo: 'asc' },
        },
      },
    });

    // Admin log (fire-and-forget after response)
    const levelLines: string[] = [];
    if (wantLineUsers && levels.length > 0) {
      const allUserIds = levels
        .flatMap((lv) => lv.users || [])
        .filter((u) => u.slotType === 'FIXED_USER' && u.id)
        .map((u) => Number(u.id));

      const users =
        allUserIds.length > 0
          ? await this.prisma.user.findMany({
              where: { id: { in: allUserIds } },
              select: { id: true, name: true, lastname: true },
            })
          : [];

      const userMap = new Map(users.map((u) => [u.id, `${u.name} ${u.lastname || ''}`.trim()]));
      levels.forEach((lv, idx) => {
        const approverNames = (lv.users || []).map((u) => {
          const userName =
            u.slotType === 'FIXED_USER' && u.id
              ? userMap.get(Number(u.id)) || `User ID: ${u.id}`
              : 'FLEXIBLE_SLOT';
          return `${userName} (${u.isSigReq ? 'SigReq' : 'NoSigReq'})`;
        });
        levelLines.push(`Level ${idx + 1}: ${approverNames.join(', ')}`);
      });
    }

    await this.adminLog.write(user.id, 'MEMO_TYPE_CREATE', 'MEMO_TYPE', full?.id ?? 0, full?.name ?? name, {
      name,
      abbreviation,
      description,
      businessUnit: (full as any)?.businessUnit?.name ?? null,
      department: (full as any)?.department?.name ?? null,
      forEveryone: fe,
      forEveryDepartmentAcrossBU: fac,
      forAllDepartmentUnderSelectedBu: fbu,
      isDelete,
      duplicatedFrom: duplicateFromId ?? null,
      levels: levelLines.length > 0 ? levelLines : null,
    });

    return full;
  }

  // ---------------------------------------------------------------------------
  // PUT /api/memotypes/:id
  // ---------------------------------------------------------------------------

  async updateMEMOType(
    user: JwtPayload,
    id: number,
    body: Record<string, unknown>,
    files: Express.Multer.File[],
  ) {
    const name = (body['name'] as string | undefined)?.toString?.() ?? '';
    const description = (body['description'] as string | undefined)?.toString?.() ?? '';
    const abbreviation = (body['abbreviation'] as string | undefined)?.toString?.() ?? '';
    const isActiveRaw = body['isActive'];
    const isDeleteRaw = body['isDelete'];
    const buIdNorm = normalizeOptionalId(body['businessUnitId']);
    const depIdNorm = normalizeOptionalId(body['departmentId']);

    if (!Number.isFinite(id) || !name || !description) {
      throw new BadRequestException('Invalid data');
    }

    const existing = await this.prisma.memoType.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        abbreviation: true,
        description: true,
        isActive: true,
        isDelete: true,
        approvalLineId: true,
        businessUnitId: true,
        businessUnit: { select: { name: true } },
        departmentId: true,
        department: { select: { name: true } },
        forEveryone: true,
        forEveryDepartmentAcrossBU: true,
        forAllDepartmentUnderSelectedBu: true,
        createdByUserId: true,
      },
    });
    if (!existing) throw new NotFoundException('Type not found');

    const canManageAll = isAdminOrDcc(user);
    if (!canManageAll && existing.createdByUserId !== user?.id) {
      throw new ForbiddenException('You cannot modify this type.');
    }

    if (!existing.approvalLineId) {
      throw new BadRequestException(
        'This document type has no approval line assigned yet. Please create or attach an approval line first.',
      );
    }

    const updateData: Record<string, unknown> = {
      name,
      description,
      abbreviation: abbreviation ?? '',
      updatedAt: new Date(),
    };
    let newBuName: string | null = null;
    let newDeptName: string | null = null;

    if (typeof isDeleteRaw === 'boolean') updateData['isDelete'] = isDeleteRaw;
    if (typeof isDeleteRaw === 'string') updateData['isDelete'] = isDeleteRaw === 'true';
    if (typeof isActiveRaw === 'boolean') updateData['isActive'] = isActiveRaw;
    if (typeof isActiveRaw === 'string') updateData['isActive'] = isActiveRaw === 'true';

    if (existing.isDelete && updateData['isDelete'] !== false) {
      if (updateData['isActive'] !== undefined && updateData['isActive'] !== existing.isActive) {
        throw new BadRequestException('Cannot change active status of a deleted memo type.');
      }
    }

    const hasBUKey = Object.prototype.hasOwnProperty.call(body, 'businessUnitId');
    if (hasBUKey) {
      if (buIdNorm == null) {
        updateData['businessUnitId'] = null;
      } else {
        const buExists = await this.prisma.businessUnit.findUnique({
          where: { id: buIdNorm },
          select: { id: true, name: true },
        });
        if (!buExists) throw new BadRequestException('Business Unit not found');
        updateData['businessUnitId'] = buIdNorm;
        newBuName = buExists.name;
      }
    }

    const hasDeptKey = Object.prototype.hasOwnProperty.call(body, 'departmentId');
    if (hasDeptKey) {
      if (depIdNorm == null) {
        updateData['departmentId'] = null;
      } else {
        const depExists = await this.prisma.department.findUnique({
          where: { id: depIdNorm },
          select: { id: true, name: true },
        });
        if (!depExists) throw new BadRequestException('Department not found');
        updateData['departmentId'] = depIdNorm;
        newDeptName = depExists.name;
      }
    }

    const hasFEKey = Object.prototype.hasOwnProperty.call(body, 'forEveryone');
    const hasFACKey = Object.prototype.hasOwnProperty.call(body, 'forEveryDepartmentAcrossBU');
    const hasFBUKey = Object.prototype.hasOwnProperty.call(body, 'forAllDepartmentUnderSelectedBu');

    const feInput = hasFEKey ? parseBool(body['forEveryone']) : undefined;
    const facInput = hasFACKey ? parseBool(body['forEveryDepartmentAcrossBU']) : undefined;
    const fbuInput = hasFBUKey ? parseBool(body['forAllDepartmentUnderSelectedBu']) : undefined;

    const inputTrueCount = [feInput, facInput, fbuInput].filter((v) => v === true).length;
    if (inputTrueCount > 1) {
      throw new BadRequestException(
        'Only one of {forEveryone, forEveryDepartmentAcrossBU, forAllDepartmentUnderSelectedBu} can be true',
      );
    }

    let finalFE = existing.forEveryone;
    let finalFAC = existing.forEveryDepartmentAcrossBU;
    let finalFBU = existing.forAllDepartmentUnderSelectedBu;
    if (feInput !== undefined) finalFE = feInput;
    if (facInput !== undefined) finalFAC = facInput;
    if (fbuInput !== undefined) finalFBU = fbuInput;

    if (finalFE) { finalFAC = false; finalFBU = false; }
    else if (finalFAC) { finalFE = false; finalFBU = false; }
    else if (finalFBU) { finalFE = false; finalFAC = false; }

    updateData['forEveryone'] = finalFE;
    updateData['forEveryDepartmentAcrossBU'] = finalFAC;
    updateData['forAllDepartmentUnderSelectedBu'] = finalFBU;

    const buWillBe = hasBUKey ? (buIdNorm ?? null) : (existing.businessUnitId ?? null);
    const deptWillBe = hasDeptKey ? (depIdNorm ?? null) : (existing.departmentId ?? null);
    const isNoModeFinal = !finalFE && !finalFAC && !finalFBU;

    if (!finalFE && buWillBe == null) throw new BadRequestException('businessUnitId is required');
    if (finalFAC && deptWillBe == null) throw new BadRequestException('departmentId is required when forEveryDepartmentAcrossBU is true');
    if (isNoModeFinal && deptWillBe == null) throw new BadRequestException('departmentId is required when forAllDepartmentUnderSelectedBu is false');

    if (finalFE) {
      updateData['businessUnitId'] = null;
      updateData['departmentId'] = null;
    } else {
      updateData['businessUnitId'] = buWillBe;
      updateData['departmentId'] = deptWillBe;
    }

    const wantUpdateApproval =
      String(body['updateApprovalLine'] ?? '').toLowerCase() === 'true' ||
      typeof body['approvalLevels'] !== 'undefined';

    let levels: Array<{
      level?: number;
      approvalRequirement?: string;
      users: Array<{
        id?: number | null;
        isSigReq?: boolean;
        slotType?: string;
        roleDescription?: string | null;
        approvalRequirement?: string;
      }>;
    }> = [];

    if (wantUpdateApproval) {
      let raw = body['approvalLevels'] as string | string[] | undefined;
      if (Array.isArray(raw)) raw = raw[0];
      if (typeof raw === 'string' && raw.trim() !== '') {
        try {
          levels = JSON.parse(raw);
        } catch {
          throw new BadRequestException('Invalid JSON in approvalLevels');
        }
      } else {
        throw new BadRequestException('approvalLevels is required');
      }

      for (let i = 0; i < levels.length; i++) {
        const lv = levels[i];
        if ((lv.users?.length ?? 0) === 0) {
          throw new BadRequestException(`Level ${i + 1} must have at least one approver`);
        }
        const seenInLevel = new Set<number>();
        for (const u of lv.users) {
          if (u.slotType === 'FIXED_USER' && u.id) {
            const uid = Number(u.id);
            if (seenInLevel.has(uid)) {
              throw new BadRequestException(`Duplicate approver at the same level (Level ${i + 1})`);
            }
            seenInLevel.add(uid);
          }
        }
      }
    }

    // ── Transaction ──────────────────────────────────────────────────────────
    await this.prisma.$transaction(async (tx) => {
      await tx.memoType.update({ where: { id }, data: updateData });

      const lineId = existing.approvalLineId!;
      const buFinalForLine =
        finalFE || finalFAC ? null : (updateData['businessUnitId'] as number | null | undefined) ?? existing.businessUnitId ?? null;

      await tx.lineOfApproval.update({
        where: { id: lineId },
        data: { name: name, businessUnitId: buFinalForLine },
      });

      if (wantUpdateApproval) {
        await tx.lineOfApprovalUserPivot.deleteMany({ where: { lineOfApprovalId: lineId } });

        const rows = levels.flatMap((lv, lvIdx) =>
          (lv.users || []).map((u) => ({
            lineOfApprovalId: lineId,
            userId: u.slotType === 'FIXED_USER' ? (Number(u.id) || null) : null,
            level:
              typeof lv.level === 'number' && Number.isFinite(lv.level) ? Number(lv.level) : lvIdx,
            isSigReq: !!u.isSigReq,
            slotType: (u.slotType || 'FIXED_USER') as ApprovalSlotType,
            roleDescription: u.roleDescription ?? null,
            approvalRequirement: (u.approvalRequirement || lv.approvalRequirement || 'ALL') as ApprovalRequirement,
          })),
        );

        if (rows.length > 0) {
          await tx.lineOfApprovalUserPivot.createMany({ data: rows });
        }
      }
    });

    // ── File uploads ──────────────────────────────────────────────────────────
    if (files.length > 0) {
      const typeDir = path.join(UPLOADS_DIR, 'types');
      fs.mkdirSync(typeDir, { recursive: true });

      const existingTypeFiles = await this.prisma.typeFile.findMany({
        where: { memoTypeId: id },
        select: { orderNo: true },
        orderBy: { orderNo: 'desc' },
        take: 1,
      });
      const startOrder = existingTypeFiles.length > 0 ? existingTypeFiles[0].orderNo + 1 : 0;

      for (let idx = 0; idx < files.length; idx++) {
        const f = files[idx];
        const original = safeFileName(decodeFilename(f.originalname || `file_${idx}`));
        const base = `${Date.now()}_${idx}_${original}`;
        fs.writeFileSync(path.join(typeDir, base), f.buffer);

        await this.prisma.typeFile.create({
          data: {
            memoTypeId: id,
            filePath: `/uploads/types/${base}`,
            fileName: decodeFilename(f.originalname || `file_${idx}`),
            size: f.size ?? 0,
            orderNo: startOrder + idx,
          },
          select: { id: true, orderNo: true },
        });
      }
    } else {
      // Handle defaultTypeFileId change for existing files (no new uploads)
      const defaultTypeFileIdRaw = body['defaultTypeFileId'];
      if (defaultTypeFileIdRaw !== undefined) {
        const typeFileId = defaultTypeFileIdRaw === '' ? null : Number(defaultTypeFileIdRaw);
        const finalId =
          typeFileId === null || (Number.isFinite(typeFileId) && (typeFileId as number) > 0)
            ? typeFileId
            : undefined;
        if (finalId !== undefined) {
          await this.prisma.memoType.update({
            where: { id },
            data: { defaultTypeFileId: finalId },
          });
        }
      }
    }

    const full = await this.prisma.memoType.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        description: true,
        abbreviation: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        defaultTypeFileId: true,
        approvalLineId: true,
        businessUnitId: true,
        departmentId: true,
        department: { select: { id: true, name: true } },
        businessUnit: { select: { id: true, name: true } },
        forEveryone: true,
        forEveryDepartmentAcrossBU: true,
        forAllDepartmentUnderSelectedBu: true,
        typeFiles: {
          select: { id: true, fileName: true, filePath: true, size: true, orderNo: true },
          orderBy: { orderNo: 'asc' },
        },
      },
    });

    // Logging
    try {
      const logDetails: Prisma.JsonObject = {};
      if (existing.name !== name) { logDetails['oldName'] = existing.name; logDetails['newName'] = name; }
      if (Object.keys(logDetails).length > 0) {
        await this.adminLog.write(user.id, 'MEMO_TYPE_UPDATE', 'MEMO_TYPE', id, name, logDetails as Prisma.InputJsonValue);
      }
    } catch (logErr) {
      this.logger.error('Failed to create admin log', logErr);
    }

    return full;
  }

  // ---------------------------------------------------------------------------
  // DELETE /api/memotypes/:id
  // ---------------------------------------------------------------------------

  async deleteMEMOType(user: JwtPayload, id: number) {
    const existing = await this.prisma.memoType.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        abbreviation: true,
        description: true,
        isActive: true,
        approvalLineId: true,
        createdByUserId: true,
        businessUnit: { select: { name: true } },
        department: { select: { name: true } },
        forEveryone: true,
        forEveryDepartmentAcrossBU: true,
        forAllDepartmentUnderSelectedBu: true,
      },
    });
    if (!existing) throw new NotFoundException('Type not found');

    // Build level info for logging before deletion
    const levelLines: string[] = [];
    if (existing.approvalLineId) {
      const pivots = await this.prisma.lineOfApprovalUserPivot.findMany({
        where: { lineOfApprovalId: existing.approvalLineId },
        include: { user: { select: { id: true, name: true, lastname: true } } },
        orderBy: { level: 'asc' },
      });
      const groups: Record<number, typeof pivots> = {};
      pivots.forEach((p) => {
        const lv = p.level ?? 0;
        (groups[lv] ??= []).push(p);
      });
      Object.entries(groups)
        .sort(([a], [b]) => Number(a) - Number(b))
        .forEach(([lvl, items]) => {
          const names = items.map((p) => {
            const uName =
              p.slotType === 'FIXED_USER' && p.user
                ? `${p.user.name} ${p.user.lastname || ''}`.trim()
                : 'FLEXIBLE_SLOT';
            return `${uName} (${p.isSigReq ? 'SigReq' : 'NoSigReq'})`;
          });
          levelLines.push(`Level ${Number(lvl) + 1}: ${names.join(', ')}`);
        });
    }

    const memoCount = await this.prisma.masterMemo.count({ where: { memotypeId: id } });
    if (memoCount > 0) {
      throw new ForbiddenException(`Cannot delete type that is referenced by memos`);
    }

    const fileRecs = await this.prisma.typeFile.findMany({
      where: { memoTypeId: id },
      select: { id: true, filePath: true },
    });
    const fileIds = fileRecs.map((f) => f.id);

    await this.prisma.$transaction(async (tx) => {
      if (fileIds.length > 0) {
        await tx.typeFile.deleteMany({ where: { id: { in: fileIds } } });
      }
      if (existing.approvalLineId) {
        const lineRefCount = await tx.masterMemo.count({
          where: { approvalLineId: existing.approvalLineId },
        });
        if (lineRefCount === 0) {
          await tx.lineOfApprovalUserPivot.deleteMany({
            where: { lineOfApprovalId: existing.approvalLineId },
          });
          await tx.lineOfApproval.delete({ where: { id: existing.approvalLineId } });
        }
      }
      await tx.memoType.delete({ where: { id } });
    });

    // Delete physical files
    for (const f of fileRecs) {
      try {
        const local = toLocalPath(f.filePath || '');
        if (local.startsWith(UPLOADS_DIR) && fs.existsSync(local)) {
          fs.unlinkSync(local);
        }
      } catch (e) {
        this.logger.warn(`unlink failed: ${f.filePath}`, e);
      }
    }

    await this.adminLog.write(user.id, 'MEMO_TYPE_DELETE', 'MEMO_TYPE', id, existing.name, {
      name: existing.name,
      abbreviation: existing.abbreviation,
      description: existing.description,
      isActive: existing.isActive,
      businessUnit: existing.businessUnit?.name ?? null,
      department: existing.department?.name ?? null,
      forEveryone: existing.forEveryone,
      forEveryDepartmentAcrossBU: existing.forEveryDepartmentAcrossBU,
      forAllDepartmentUnderSelectedBu: existing.forAllDepartmentUnderSelectedBu,
      levels: levelLines.length > 0 ? levelLines : null,
      deletedFilesCount: fileRecs.length,
    });
  }

  // ---------------------------------------------------------------------------
  // DELETE /api/memotypes/:typeId/files/:fileId
  // ---------------------------------------------------------------------------

  async deleteMEMOTypeFile(user: JwtPayload, typeId: number, fileId: number) {
    const type = await this.prisma.memoType.findUnique({ where: { id: typeId } });
    if (!type) throw new NotFoundException('Type not found');

    const tf = await this.prisma.typeFile.findFirst({
      where: { id: fileId, memoTypeId: typeId },
      select: { id: true, filePath: true },
    });
    if (!tf) throw new NotFoundException('File not found');

    await this.prisma.$transaction(async (tx) => {
      await tx.typeFile.delete({ where: { id: fileId } });
    });

    try {
      const local = toLocalPath(tf.filePath || '');
      if (local.startsWith(UPLOADS_DIR) && fs.existsSync(local)) {
        fs.unlinkSync(local);
      }
    } catch (e) {
      this.logger.warn(`unlink failed: ${tf.filePath}`, e);
    }

    await this.adminLog.write(user.id, 'MEMO_TYPE_FILE_DELETE', 'MEMO_TYPE', typeId, type.name, {
      fileId,
      filePath: tf.filePath,
    });
  }
}
