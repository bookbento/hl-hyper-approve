import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminLogService } from '../../common/admin-log/admin-log.service';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';

// ─── helpers ────────────────────────────────────────────────────────────────

const toPublicUrl = (p?: string | null): string | null =>
  p ? `/uploads/${String(p).replace(/^\/+/, '').replace(/\\/g, '/')}` : null;

function mapPrismaError(err: unknown): { status: number; error: string } {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    const fields = (err.meta?.target as string[]) ?? [];
    return { status: 409, error: `Duplicate value on: ${fields.join(', ')}` };
  }
  return { status: 500, error: 'Internal server error' };
}

const normalizeEmail = (e: string) => e.trim().toLowerCase();

const EMAIL_ASCII_LOWER = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/;
const HAS_NON_ASCII = /[^\x00-\x7F]/;

function validateEmailFormat(emailRaw: string): string {
  if (/[A-Z]/.test(emailRaw)) {
    throw new BadRequestException('Email ต้องเป็นตัวพิมพ์เล็กเท่านั้น (a-z)');
  }
  if (HAS_NON_ASCII.test(emailRaw)) {
    throw new BadRequestException('Email ห้ามมีอักษรไทยหรืออักขระนอก ASCII');
  }
  if (!EMAIL_ASCII_LOWER.test(emailRaw)) {
    throw new BadRequestException('รูปแบบ Email ไม่ถูกต้อง (ใช้ a-z, 0-9 และ ._%+- เท่านั้น)');
  }
  return emailRaw;
}

/** Mirror Express createUserWithRetry — handles PK collision with retry */
async function createUserWithRetry(
  prisma: PrismaService,
  data: Prisma.UserUncheckedCreateInput,
  maxRetries = 10,
): Promise<Record<string, unknown>> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const maxUser = await prisma.user.findFirst({
        orderBy: { id: 'desc' },
        select: { id: true },
      });

      const nextId = maxUser ? maxUser.id + 1 : 1;

      return await prisma.user.create({ data: { ...data, id: nextId } }) as any;
    } catch (err: unknown) {
      lastError = err;

      if (!(err instanceof Prisma.PrismaClientKnownRequestError)) throw err;
      if (err.code !== 'P2002') throw err;

      const target = String((err.meta?.target) ?? '');
      if (target.includes('email')) throw err; // real email dup
      // else retry (PK race)
    }
  }

  throw lastError ?? new Error('Failed to create user after retries');
}

// ─── service ────────────────────────────────────────────────────────────────

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adminLog: AdminLogService,
  ) {}

  // ── BU + department lookup helpers ────────────────────────────────────────

  private async resolveBusinessUnit(
    businessUnitName?: string,
    businessUnitIdRaw?: number | string | null,
  ): Promise<number | null> {
    if (businessUnitName?.trim()) {
      const bu = await this.prisma.businessUnit.findUnique({
        where: { name: businessUnitName.trim() },
      });
      if (!bu) throw new BadRequestException('Invalid business unit name');
      return bu.id;
    }

    if (businessUnitIdRaw != null && String(businessUnitIdRaw).trim() !== '') {
      const id = Number(businessUnitIdRaw);
      if (Number.isNaN(id)) throw new BadRequestException('Invalid businessUnitId');
      const bu = await this.prisma.businessUnit.findUnique({ where: { id } });
      if (!bu) throw new BadRequestException('Invalid businessUnitId');
      return id;
    }

    return null;
  }

  private async resolveDepartment(
    departmentName?: string,
    departmentIdRaw?: number | string | null,
  ): Promise<number | null> {
    if (departmentName?.trim()) {
      const dept = await this.prisma.department.findUnique({
        where: { name: departmentName.trim() },
      });
      if (!dept) throw new BadRequestException('Invalid department name');
      return dept.id;
    }

    if (departmentIdRaw != null && String(departmentIdRaw).trim() !== '') {
      const id = Number(departmentIdRaw);
      if (Number.isNaN(id)) throw new BadRequestException('Invalid departmentId');
      const dept = await this.prisma.department.findUnique({ where: { id } });
      if (!dept) throw new BadRequestException('Invalid departmentId');
      return id;
    }

    return null;
  }

  private buInclude() {
    return {
      department: true,
      businessUnit: true,
      businessUnitAccess: {
        include: {
          businessUnit: { select: { id: true, name: true, abbreviation: true } },
        },
      },
    } as const;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  async getAllUsers() {
    const users = await this.prisma.user.findMany({
      where: { deletedAt: null },
      include: this.buInclude(),
    });

    return users.map(({ password: _pw, profileImagePath, ...rest }) => ({
      ...rest,
      profileImageUrl: toPublicUrl(profileImagePath),
    }));
  }

  async getArchivedUsers() {
    const users = await this.prisma.user.findMany({
      where: { deletedAt: { not: null } },
      include: this.buInclude(),
      orderBy: { deletedAt: 'desc' },
    });

    return users.map(({ password: _pw, profileImagePath, deletedAt, ...rest }) => ({
      ...rest,
      profileImageUrl: toPublicUrl(profileImagePath),
      deletedAt,
    }));
  }

  async getUserById(id: number) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: this.buInclude(),
    });

    if (!user || user.deletedAt) {
      throw new NotFoundException('User not found');
    }

    const { password: _pw, profileImagePath, ...safe } = user;
    return { ...safe, profileImageUrl: toPublicUrl(profileImagePath) };
  }

  async checkEmailExists(email: string, excludeId?: number): Promise<{ exists: boolean }> {
    if (!email) throw new BadRequestException('Email is required');

    const user = await this.prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
    const exists = user ? (excludeId ? user.id !== excludeId : true) : false;
    return { exists };
  }

  async searchUsers(q: string, limit: number, excludeIds: number[]) {
    const safeLimit = Math.min(limit || 10, 50);
    const whereCondition = q
      ? {
          AND: [
            {
              OR: [
                { name: { contains: q, mode: 'insensitive' as const } },
                { email: { contains: q, mode: 'insensitive' as const } },
                { nickname: { contains: q, mode: 'insensitive' as const } },
                { lastname: { contains: q, mode: 'insensitive' as const } } as any,
              ],
            },
            excludeIds.length ? { id: { notIn: excludeIds } } : {},
            { deletedAt: null },
          ],
        }
      : {
          AND: [
            excludeIds.length ? { id: { notIn: excludeIds } } : {},
            { deletedAt: null },
          ],
        };

    const users = (await this.prisma.user.findMany({
      where: whereCondition,
      include: { department: true },
      orderBy: [{ name: 'asc' }, { lastname: 'asc' } as any],
      take: q ? safeLimit : Math.min(safeLimit * 2, 100),
    })) as Prisma.UserGetPayload<{ include: { department: true } }>[];

    return users.map((u: any) => ({
      id: u.id,
      name: u.name,
      lastname: u.lastname ?? null,
      nickname: u.nickname ?? null,
      email: u.email,
      department: u.department?.name ?? null,
      profileImageUrl: toPublicUrl(u.profileImagePath),
    }));
  }

  async getUsersBasicInfo(ids: string) {
    if (!ids) throw new BadRequestException('Missing ids parameter');

    const userIds = String(ids)
      .split(',')
      .map(Number)
      .filter((id) => !isNaN(id) && id > 0);

    if (userIds.length === 0) throw new BadRequestException('Invalid ids format');
    if (userIds.length > 50) throw new BadRequestException('Too many IDs requested');

    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds }, deletedAt: null },
      select: {
        id: true,
        name: true,
        lastname: true,
        nickname: true,
        profileImagePath: true,
      },
    });

    return users.map((user: any) => ({
      id: user.id,
      name: user.name,
      lastname: user.lastname ?? null,
      nickname: user.nickname ?? null,
      profileImageUrl: toPublicUrl(user.profileImagePath),
    }));
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  async createUser(
    body: Record<string, any>,
    actorId: number | undefined,
    profileImagePath: string | null,
  ) {
    // Prevent client from injecting id
    const { name, lastname, nickname, email, password, role,
      businessUnitName, departmentName, businessUnitId: buIdRaw, departmentId: deptIdRaw } = body;

    if (!name?.trim() || !email?.trim() || !password?.trim() || !role?.trim()) {
      throw new BadRequestException('Missing required fields');
    }

    const emailRaw = String(email).trim();
    validateEmailFormat(emailRaw);

    const emailDup = await this.prisma.user.findUnique({ where: { email: emailRaw } });
    if (emailDup) throw new ConflictException('Email already exists');

    const businessUnitId = await this.resolveBusinessUnit(businessUnitName, buIdRaw);
    const departmentId = await this.resolveDepartment(departmentName, deptIdRaw);

    const hashedPassword = await bcrypt.hash(password, 10);

    const userData: Prisma.UserUncheckedCreateInput = {
      name: name.trim(),
      lastname: (lastname ?? '').toString().trim() || null,
      nickname: (nickname ?? '').toString().trim() || null,
      email: emailRaw,
      password: hashedPassword,
      role: role.trim().toLowerCase(),
      businessUnitId: businessUnitId ?? null,
      departmentId: departmentId ?? null,
      profileImagePath,
      isFirstLogin: true,
    };

    const created = await createUserWithRetry(this.prisma, userData);
    const { password: _pw, profileImagePath: imgPath, ...rest } = created as any;

    if (actorId) {
      await this.adminLog.write(
        actorId, 'USER_CREATE', 'USER', (created as any).id as number,
        `${(created as any).name} ${(created as any).lastname || ''}`.trim(),
        {
          email: (created as any).email,
          role: (created as any).role,
          businessUnitId: (created as any).businessUnitId,
          departmentId: (created as any).departmentId,
        },
      );
    }

    return { ...rest, profileImageUrl: toPublicUrl(imgPath) };
  }

  async updateUser(
    id: number,
    body: Record<string, any>,
    actorId: number | undefined,
    file: any | undefined,
  ) {
    const existingUser = await this.prisma.user.findUnique({ where: { id } });
    if (!existingUser) throw new NotFoundException('User not found');

    const {
      name, lastname, nickname, email, password, role,
      businessUnitName, departmentName,
      businessUnitId: buIdRaw, departmentId: deptIdRaw,
      defaultSignatureText, clearImage,
    } = body ?? {};

    const updateData: Record<string, any> = {};

    if (typeof name === 'string' && name.trim()) updateData['name'] = name.trim();
    if (lastname !== undefined) updateData['lastname'] = (lastname ?? '').toString().trim() || null;
    if (nickname !== undefined) updateData['nickname'] = (nickname ?? '').toString().trim() || null;
    if (defaultSignatureText !== undefined) {
      updateData['defaultSignatureText'] = (defaultSignatureText ?? '').toString().trim() || null;
    }
    if (typeof role === 'string' && role.trim()) updateData['role'] = role.trim().toLowerCase();
    if (typeof password === 'string' && password.trim()) {
      updateData['password'] = await bcrypt.hash(password, 10);
    }

    if (typeof email === 'string' && email.trim()) {
      const emailNorm = normalizeEmail(email);
      if (emailNorm !== existingUser.email) {
        const dup = await this.prisma.user.findUnique({ where: { email: emailNorm } });
        if (dup && dup.id !== id) throw new ConflictException('Email already exists');
      }
      updateData['email'] = normalizeEmail(email);
    }

    if (businessUnitName !== undefined || buIdRaw !== undefined) {
      const buId = await this.resolveBusinessUnit(businessUnitName, buIdRaw);
      updateData['businessUnitId'] = buId;
    }

    if (departmentName !== undefined || deptIdRaw !== undefined) {
      const deptId = await this.resolveDepartment(departmentName, deptIdRaw);
      updateData['departmentId'] = deptId;
    }

    if (file) {
      const p = (file.path || file.filename || '').replace(/\\/g, '/');
      const m = p.match(/(?:^|\/)profiles\/(.+)$/);
      updateData['profileImagePath'] = m ? `profiles/${m[1]}` : `profiles/${p.split('/').pop() || ''}`;
    } else if (clearImage === '1' || clearImage === true) {
      updateData['profileImagePath'] = null;
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: updateData,
      include: this.buInclude(),
    });

    const { password: _pw, profileImagePath, ...rest } = updated;

    if (actorId && Object.keys(updateData).length > 0) {
      const changes: Record<string, { old: unknown; new: unknown }> = {};
      for (const key of Object.keys(updateData)) {
        const oldValue = key === 'password' ? '********' : (existingUser as any)[key];
        const newValue = key === 'password' ? 'CHANGED' : updateData[key];
        if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
          changes[key] = { old: oldValue, new: newValue };
        }
      }
      if (Object.keys(changes).length > 0) {
        await this.adminLog.write(
          actorId, 'USER_UPDATE', 'USER', updated.id,
          `${updated.name} ${(updated as any).lastname || ''}`.trim(),
          { changes } as unknown as import('@prisma/client').Prisma.InputJsonValue,
        );
      }
    }

    return { ...rest, profileImageUrl: toPublicUrl(profileImagePath) };
  }

  async deleteUser(id: number, actorId: number | undefined) {
    const existingUser = await this.prisma.user.findUnique({ where: { id } });
    if (!existingUser || existingUser.deletedAt) throw new NotFoundException('User not found');

    await this.prisma.user.update({ where: { id }, data: { deletedAt: new Date() } });

    if (actorId) {
      await this.adminLog.write(
        actorId, 'USER_ARCHIVE', 'USER', existingUser.id,
        `${existingUser.name} ${(existingUser as any).lastname || ''}`.trim(),
        { email: existingUser.email, role: existingUser.role },
      );
    }
  }

  async restoreUser(id: number, actorId: number | undefined) {
    const existingUser = await this.prisma.user.findUnique({ where: { id } });
    if (!existingUser) throw new NotFoundException('User not found');
    if (!existingUser.deletedAt) throw new BadRequestException('User is not archived');

    await this.prisma.user.update({ where: { id }, data: { deletedAt: null } });

    if (actorId) {
      await this.adminLog.write(
        actorId, 'USER_RESTORE', 'USER', existingUser.id,
        `${existingUser.name} ${(existingUser as any).lastname || ''}`.trim(),
        { email: existingUser.email, role: existingUser.role },
      );
    }
  }

  async changePassword(id: number, current: string, next: string) {
    if (!current || !next) throw new BadRequestException('Missing fields');

    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    const match = await bcrypt.compare(current, user.password);
    if (!match) throw new UnauthorizedException('Current password incorrect');

    const isFirstLogin = user.isFirstLogin === true;
    const hashed = await bcrypt.hash(next, 10);

    await this.prisma.user.update({
      where: { id },
      data: { password: hashed, isFirstLogin: false },
    });

    if (isFirstLogin) {
      try {
        const notificationTypes = await this.prisma.notificationType.findMany();
        const existingPrefsCount = await this.prisma.userNotificationPreference.count({ where: { userId: id } });
        if (existingPrefsCount === 0) {
          await this.prisma.userNotificationPreference.createMany({
            data: notificationTypes.map(type => ({
              userId: id,
              notificationTypeId: type.id,
              emailEnabled: true,
            })),
            skipDuplicates: true,
          });
        }
      } catch (prefError: unknown) {
        this.logger.error('Failed to initialize notification preferences on first login', prefError);
      }
    }

    return { message: 'Password changed successfully' };
  }

  async forcePasswordReset(userId: number, actorId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, deletedAt: true },
    });
    if (!user || user.deletedAt) throw new NotFoundException('User not found');

    await this.prisma.user.update({ where: { id: userId }, data: { isFirstLogin: true } });
    await this.adminLog.write(
      actorId, 'USER_FORCE_PASSWORD_RESET', 'USER', userId,
      `${user.name} (${user.email})`,
      { action: 'Force password reset on next login' },
    );

    return { success: true, message: 'User will be required to reset password on next login' };
  }

  async clearFirstLogin(userId: number, actorId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, deletedAt: true },
    });
    if (!user || user.deletedAt) throw new NotFoundException('User not found');

    await this.prisma.user.update({ where: { id: userId }, data: { isFirstLogin: false } });
    await this.adminLog.write(
      actorId, 'USER_CLEAR_FIRST_LOGIN', 'USER', userId,
      `${user.name} (${user.email})`,
      { action: 'Clear first-time login flag' },
    );

    return { success: true, message: 'First-time login flag cleared successfully' };
  }

  // ── Delegation ─────────────────────────────────────────────────────────────

  async setDelegation(
    userId: number,
    delegatedToUserId?: number,
    delegationStartDate?: string,
    delegationEndDate?: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    if (delegatedToUserId) {
      const delegatedUser = await this.prisma.user.findUnique({ where: { id: Number(delegatedToUserId) } });
      if (!delegatedUser) throw new BadRequestException('Delegated user not found');
      if (userId === Number(delegatedToUserId)) throw new BadRequestException('Cannot delegate to yourself');
    }

    if (delegationStartDate && delegationEndDate) {
      const startDate = new Date(delegationStartDate);
      const endDate = new Date(delegationEndDate);
      if (startDate >= endDate) throw new BadRequestException('Start date must be before end date');
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        delegatedToUserId: delegatedToUserId ? Number(delegatedToUserId) : null,
        delegationStartDate: delegationStartDate ? new Date(delegationStartDate) : null,
        delegationEndDate: delegationEndDate ? new Date(delegationEndDate) : null,
      },
      include: {
        delegatedToUser: {
          select: { id: true, name: true, lastname: true, nickname: true, email: true },
        },
      },
    });

    const { password: _pw, ...safeUser } = updatedUser as any;
    return safeUser;
  }

  async getDelegation(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        delegatedToUser: {
          select: { id: true, name: true, lastname: true, nickname: true, email: true },
        },
      },
    });

    if (!user) throw new NotFoundException('User not found');

    const now = new Date();
    return {
      delegatedToUser: user.delegatedToUser,
      delegationStartDate: user.delegationStartDate,
      delegationEndDate: user.delegationEndDate,
      isCurrentlyDelegated:
        user.delegatedToUserId && user.delegationStartDate && user.delegationEndDate
          ? now >= user.delegationStartDate && now <= user.delegationEndDate
          : false,
    };
  }

  async clearDelegation(userId: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: { delegatedToUserId: null, delegationStartDate: null, delegationEndDate: null },
    });

    const { password: _pw, ...safeUser } = updatedUser as any;
    return safeUser;
  }

  // ── Notification Preferences ───────────────────────────────────────────────

  async getNotificationPreferences(userId: number) {
    // Lazy init: ensure all types have a preference row
    const notificationTypes = await this.prisma.notificationType.findMany();
    const existingPrefs = await this.prisma.userNotificationPreference.findMany({
      where: { userId },
      include: { notificationType: { select: { id: true, name: true, slug: true } } },
    });

    const existingTypeIds = new Set(existingPrefs.map((p: any) => p.notificationTypeId));
    const missing = notificationTypes.filter((t: { id: number }) => !existingTypeIds.has(t.id));

    if (missing.length > 0) {
      await this.prisma.userNotificationPreference.createMany({
        data: missing.map((t: { id: number }) => ({ userId, notificationTypeId: t.id, emailEnabled: true })),
        skipDuplicates: true,
      });
    }

    const preferences = await this.prisma.userNotificationPreference.findMany({
      where: { userId },
      include: { notificationType: { select: { id: true, name: true, slug: true } } },
    });

    return { preferences };
  }

  async updateNotificationPreference(userId: number, notificationTypeId: number, emailEnabled: boolean) {
    if (typeof emailEnabled !== 'boolean') throw new BadRequestException('emailEnabled must be a boolean');
    if (isNaN(notificationTypeId)) throw new BadRequestException('Invalid notification type ID');

    const type = await this.prisma.notificationType.findUnique({ where: { id: notificationTypeId } });
    if (!type) throw new BadRequestException('Invalid notification type');

    const preference = await this.prisma.userNotificationPreference.upsert({
      where: { userId_notificationTypeId: { userId, notificationTypeId } },
      update: { emailEnabled },
      create: { userId, notificationTypeId, emailEnabled },
    });

    return {
      success: true,
      preference: {
        notificationTypeId: preference.notificationTypeId,
        emailEnabled: preference.emailEnabled,
      },
    };
  }

  async updateAllNotificationPreferences(userId: number, emailEnabled: boolean) {
    if (typeof emailEnabled !== 'boolean') throw new BadRequestException('emailEnabled must be a boolean');

    const notificationTypes = await this.prisma.notificationType.findMany();
    let updatedCount = 0;

    for (const type of notificationTypes) {
      await this.prisma.userNotificationPreference.upsert({
        where: { userId_notificationTypeId: { userId, notificationTypeId: type.id } },
        update: { emailEnabled },
        create: { userId, notificationTypeId: type.id, emailEnabled },
      });
      updatedCount++;
    }

    return { success: true, updatedCount };
  }

  // ── Business Unit Access ──────────────────────────────────────────────────

  async getUserBusinessUnitAccess(userId: number) {
    return this.prisma.userBusinessUnitAccess.findMany({
      where: { userId },
      include: { businessUnit: { select: { id: true, name: true, abbreviation: true } } },
      orderBy: { grantedAt: 'desc' },
    });
  }

  async updateUserBusinessUnitAccess(userId: number, businessUnitIds: number[], grantedBy: number | undefined) {
    if (!Array.isArray(businessUnitIds)) throw new BadRequestException('businessUnitIds must be an array');

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const existingAccess = await this.prisma.userBusinessUnitAccess.findMany({
      where: { userId },
      include: { businessUnit: { select: { id: true, name: true } } },
    });
    const oldBusinessUnits = existingAccess.map((a: any) => ({ id: a.businessUnit.id, name: a.businessUnit.name }));

    if (businessUnitIds.length > 0) {
      const businessUnits = await this.prisma.businessUnit.findMany({ where: { id: { in: businessUnitIds } } });
      if (businessUnits.length !== businessUnitIds.length) {
        throw new BadRequestException('One or more business units not found');
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.userBusinessUnitAccess.deleteMany({ where: { userId } });
      if (businessUnitIds.length > 0) {
        await tx.userBusinessUnitAccess.createMany({
          data: businessUnitIds.map((businessUnitId) => ({ userId, businessUnitId, grantedBy })),
        });
      }
    });

    const updatedAccess = await this.prisma.userBusinessUnitAccess.findMany({
      where: { userId },
      include: { businessUnit: { select: { id: true, name: true, abbreviation: true } } },
    });

    if (grantedBy) {
      const newBusinessUnits = updatedAccess.map((a: any) => ({ id: a.businessUnit.id, name: a.businessUnit.name }));
      const oldIds = oldBusinessUnits.map((b: any) => b.id).sort().join(',');
      const newIds = newBusinessUnits.map((b: any) => b.id).sort().join(',');
      if (oldIds !== newIds) {
        await this.adminLog.write(
          grantedBy, 'USER_BU_ACCESS_UPDATE', 'USER', userId,
          `${user.name} ${(user as any).lastname || ''}`.trim(),
          {
            changes: {
              additionalBusinessUnitAccess: {
                old: oldBusinessUnits.length > 0 ? oldBusinessUnits.map((b: any) => b.name) : null,
                new: newBusinessUnits.length > 0 ? newBusinessUnits.map((b: any) => b.name) : null,
              },
            },
          },
        );
      }
    }

    return updatedAccess;
  }

  async getAccessibleBusinessUnits(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { businessUnitId: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const additionalAccess = await this.prisma.userBusinessUnitAccess.findMany({
      where: { userId },
      select: { businessUnitId: true },
    });

    const businessUnitIds = new Set<number>();
    if (user.businessUnitId) businessUnitIds.add(user.businessUnitId);
    additionalAccess.forEach((a: any) => businessUnitIds.add(a.businessUnitId));

    return this.prisma.businessUnit.findMany({
      where: { id: { in: Array.from(businessUnitIds) } },
      select: { id: true, name: true, abbreviation: true },
      orderBy: { name: 'asc' },
    });
  }

  // ── DCC Management Access ─────────────────────────────────────────────────

  async getDCCManagementAccess(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });
    if (!user) throw new NotFoundException('User not found');

    return this.prisma.userDCCManagementAccess.findMany({
      where: { userId },
      include: { businessUnit: { select: { id: true, name: true, abbreviation: true } } },
      orderBy: { grantedAt: 'desc' },
    });
  }

  async updateDCCManagementAccess(
    userId: number,
    businessUnitIds: number[],
    grantedBy: number | undefined,
    requestorRole: string | undefined,
  ) {
    if ((requestorRole ?? '').toLowerCase() !== 'admin') {
      throw new BadRequestException('Only administrators can modify DCC management access');
    }
    if (!Array.isArray(businessUnitIds)) throw new BadRequestException('businessUnitIds must be an array');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, lastname: true, role: true, businessUnitId: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if ((user.role ?? '').toLowerCase() !== 'dcc') {
      throw new BadRequestException('DCC management access can only be assigned to users with DCC role');
    }

    const existingAccess = await this.prisma.userDCCManagementAccess.findMany({
      where: { userId },
      include: { businessUnit: { select: { id: true, name: true } } },
    });
    const oldBusinessUnits = existingAccess.map((a: any) => ({ id: a.businessUnit.id, name: a.businessUnit.name }));

    if (businessUnitIds.length > 0) {
      const businessUnits = await this.prisma.businessUnit.findMany({ where: { id: { in: businessUnitIds } } });
      if (businessUnits.length !== businessUnitIds.length) {
        throw new BadRequestException('One or more business units not found');
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.userDCCManagementAccess.deleteMany({ where: { userId } });
      if (businessUnitIds.length > 0) {
        await tx.userDCCManagementAccess.createMany({
          data: businessUnitIds.map((businessUnitId) => ({ userId, businessUnitId, grantedBy })),
        });
      }
    });

    const updatedAccess = await this.prisma.userDCCManagementAccess.findMany({
      where: { userId },
      include: { businessUnit: { select: { id: true, name: true, abbreviation: true } } },
      orderBy: { grantedAt: 'desc' },
    });

    if (grantedBy) {
      const newBusinessUnits = updatedAccess.map((a: any) => ({ id: a.businessUnit.id, name: a.businessUnit.name }));
      const oldIds = oldBusinessUnits.map((b: any) => b.id).sort().join(',');
      const newIds = newBusinessUnits.map((b: any) => b.id).sort().join(',');
      if (oldIds !== newIds) {
        await this.adminLog.write(
          grantedBy, 'USER_DCC_ACCESS_UPDATE', 'USER', userId,
          `${user.name} ${(user as any).lastname || ''}`.trim(),
          {
            changes: {
              dccManagementBusinessUnits: {
                old: oldBusinessUnits.length > 0 ? oldBusinessUnits.map((b: any) => b.name) : null,
                new: newBusinessUnits.length > 0 ? newBusinessUnits.map((b: any) => b.name) : null,
              },
            },
          },
        );
      }
    }

    return updatedAccess;
  }

  async getManageableBusinessUnits(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { businessUnitId: true, role: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const additionalAccess = await this.prisma.userDCCManagementAccess.findMany({
      where: { userId },
      select: { businessUnitId: true },
    });

    const businessUnitIds = new Set<number>();
    if (user.businessUnitId) businessUnitIds.add(user.businessUnitId);
    additionalAccess.forEach((a: any) => businessUnitIds.add(a.businessUnitId));

    const businessUnits = await this.prisma.businessUnit.findMany({
      where: { id: { in: Array.from(businessUnitIds) } },
      select: { id: true, name: true, abbreviation: true },
      orderBy: { name: 'asc' },
    });

    return businessUnits.map((bu) => ({ ...bu, isPrimary: bu.id === user.businessUnitId }));
  }

  async bulkGetUsers(ids: number[]) {
    return this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
  }

  async updateProfileImage(id: number, profileImagePath: string) {
    const updatedUser = await this.prisma.user.update({
      where: { id },
      data: { profileImagePath },
      include: { department: true, businessUnit: true },
    });

    const { password: _pw, ...safe } = updatedUser as any;
    return { ...safe, profileImageUrl: toPublicUrl(updatedUser.profileImagePath) };
  }
}
