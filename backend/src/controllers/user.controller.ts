import { RequestHandler } from "express";
import { prisma } from "../../prisma/client";
import bcrypt from "bcrypt";
import { Prisma } from "@prisma/client";
import { createAdminLog } from "./adminLog.controller";
import { AuthenticatedRequest } from "../types/request";
function mapPrismaError(err: any) {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // P2002 = Unique constraint failed
    if (err.code === "P2002") {
      const fields = (err.meta?.target as string[]) ?? [];
      return { status: 409, error: `Duplicate value on: ${fields.join(", ")}` };
    }
  }
  return { status: 500, error: "Internal server error" };
}

const toPublicUrl = (p?: string | null) =>
  p ? `/uploads/${String(p).replace(/^\/+/, "").replace(/\\/g, "/")}` : null;

const normalizeProfilePath = (f: Express.Multer.File) => {
  const p = (f.path || f.filename || "").replace(/\\/g, "/");
  // ถ้ามี 'profiles/...' อยู่แล้ว ตัดมาเฉพาะส่วนนี้
  const m = p.match(/(?:^|\/)profiles\/(.+)$/);
  if (m) return `profiles/${m[1]}`;
  // ไม่งั้นก็ใช้แค่ชื่อไฟล์
  const name = p.split("/").pop() || "";
  return `profiles/${name}`;
};

export const getUserById: RequestHandler = async (req, res) => {
  const id = Number(req.params.id);

  try {
    const user = await prisma.user.findUnique({
      where: { id },
      // ⬇️ ตัด team ออก เหลือเฉพาะ department / businessUnit
      include: { 
        department: true, 
        businessUnit: true,
        businessUnitAccess: {
          include: {
            businessUnit: {
              select: { id: true, name: true, abbreviation: true }
            }
          }
        }
      },
    });

    if (!user || user.deletedAt) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { password, profileImagePath, ...safe } = user; // ตัด password ออก
    res.json({ ...safe, profileImageUrl: toPublicUrl(profileImagePath) });
  } catch {
    res.status(500).json({ error: "Failed to fetch user" });
  }
};

export const getAllUsers: RequestHandler = async (_req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { deletedAt: null },
      // ⬇️ ตัด team ออก เหลือเฉพาะ department / businessUnit
      include: { 
        department: true, 
        businessUnit: true,
        businessUnitAccess: {
          include: {
            businessUnit: {
              select: { id: true, name: true, abbreviation: true }
            }
          }
        }
      },
    });

    const sanitized = users.map(({ password, profileImagePath, ...rest }) => ({
      ...rest,
      profileImageUrl: toPublicUrl(profileImagePath),
    }));

    res.json(sanitized);
  } catch {
    res.status(500).json({ error: "Failed to fetch users" });
  }
};

export const getArchivedUsers: RequestHandler = async (_req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { deletedAt: { not: null } },
      include: { 
        department: true, 
        businessUnit: true,
        businessUnitAccess: {
          include: {
            businessUnit: {
              select: { id: true, name: true, abbreviation: true }
            }
          }
        }
      },
      orderBy: { deletedAt: 'desc' },
    });

    const sanitized = users.map(({ password, profileImagePath, deletedAt, ...rest }) => ({
      ...rest,
      profileImageUrl: toPublicUrl(profileImagePath),
      deletedAt,
    }));

    res.json(sanitized);
  } catch {
    res.status(500).json({ error: "Failed to fetch archived users" });
  }
};

export const restoreUser: RequestHandler = async (req, res) => {
  const id = parseInt(req.params.id as string, 10);

  try {
    const existingUser = await prisma.user.findUnique({ where: { id } });
    if (!existingUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // Check if not deleted
    if (!existingUser.deletedAt) {
      res.status(400).json({ error: "User is not archived" });
      return;
    }

    // Restore: clear deletedAt timestamp
    await prisma.user.update({
      where: { id },
      data: { deletedAt: null }
    });

    // Log the action
    const actorId = (req as AuthenticatedRequest).user?.id;
    if (actorId) {
      await createAdminLog(
        actorId,
        "USER_RESTORE",
        "USER",
        existingUser.id,
        `${existingUser.name} ${existingUser.lastname || ""}`.trim(),
        {
          email: existingUser.email,
          role: existingUser.role,
          lastname: existingUser.lastname,
          nickname: existingUser.nickname,
          businessUnitId: existingUser.businessUnitId,
          businessUnitName: existingUser.businessUnitId ? (await prisma.businessUnit.findUnique({where: {id: existingUser.businessUnitId}}))?.name : null,
          departmentId: existingUser.departmentId,
          departmentName: existingUser.departmentId ? (await prisma.department.findUnique({where: {id: existingUser.departmentId}}))?.name : null,
        }
      );
    }

    res.sendStatus(204);
    return;
  } catch (error) {
    console.error("Failed to restore user:", error);
    res.status(500).json({ error: "Failed to restore user" });
    return;
  }
};


const normalizeEmail = (e: string) => e.trim().toLowerCase();

async function createUserWithRetry(
  data: Prisma.UserUncheckedCreateInput
) {
  const maxRetries = 10;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // 🔧 FIX: Get the maximum ID and explicitly set the next ID
      const maxUser = await prisma.user.findFirst({
        orderBy: { id: 'desc' },
        select: { id: true }
      });
      
      const nextId = maxUser ? maxUser.id + 1 : 1;
      
      // 👇 Create user with explicit ID
      return await prisma.user.create({ 
        data: {
          ...data,
          id: nextId
        }
      });
    } catch (err: any) {
      lastError = err;

      // ถ้าไม่ใช่ error ของ Prisma → โยนออกเลย
      if (!(err instanceof Prisma.PrismaClientKnownRequestError)) {
        throw err;
      }

      // ถ้าไม่ใช่ unique constraint (P2002) → โยนออกเลย
      if (err.code !== "P2002") {
        throw err;
      }

      const target = String(err.meta?.target ?? "");

      // ถ้าเป็น unique email → อันนี้คือเคสอีเมลซ้ำจริง ๆ → ไม่ retry
      if (target.includes("email")) {
        throw err;
      }

      // ถึงตรงนี้คือ unique อื่น (เช่น PK, id) ให้ retry
      console.warn(
        `[createUserWithRetry] Unique constraint on ${target}, retrying... (attempt ${attempt})`
      );

      // Retry with next attempt - will recalculate max ID
      continue;
    }
  }

  // ถ้าครบ maxRetries แล้วยังไม่รอด → โยน error ล่าสุดออกไป
  throw lastError ?? new Error("Failed to create user after retries");
}


// ✅ สร้างผู้ใช้แบบไม่รับ/ไม่ใช้ id จาก client + บังคับอีเมลตัวพิมพ์เล็ก ASCII เท่านั้น
export const createUser: RequestHandler = async (req, res) => {
  try {
    // กัน client ส่ง id มาแทรก sequence
    if (req.body && "id" in req.body) {
      delete (req.body as any).id;
    }

    const {
      name,
      lastname,
      nickname,
      email,
      password,
      role,

      businessUnitName,
      departmentName,
      businessUnitId: buIdRaw,
      departmentId: deptIdRaw,
    } = (req.body || {}) as Record<string, any>;

    // ---- validate ขั้นต่ำ ----
    if (!name?.trim() || !email?.trim() || !password?.trim() || !role?.trim()) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }

    // ---- ตรวจรูปแบบอีเมล: พิมพ์เล็ก ASCII เท่านั้น ----
    const EMAIL_ASCII_LOWER = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/;
    const HAS_NON_ASCII = /[^\x00-\x7F]/;

    const emailRaw = String(email).trim();
    if (/[A-Z]/.test(emailRaw)) {
      res.status(400).json({ error: "Email ต้องเป็นตัวพิมพ์เล็กเท่านั้น (a-z)" });
      return;
    }
    if (HAS_NON_ASCII.test(emailRaw)) {
      res.status(400).json({ error: "Email ห้ามมีอักษรไทยหรืออักขระนอก ASCII" });
      return;
    }
    if (!EMAIL_ASCII_LOWER.test(emailRaw)) {
      res.status(400).json({ error: "รูปแบบ Email ไม่ถูกต้อง (ใช้ a-z, 0-9 และ ._%+- เท่านั้น)" });
      return;
    }
    const emailNorm = emailRaw;

    // ---- กันอีเมลซ้ำ ----
    const emailDup = await prisma.user.findUnique({ where: { email: emailNorm } });
    if (emailDup) {
      res.status(409).json({ error: "Email already exists" });
      return;
    }

    // ---- business unit ----
    let businessUnitId: number | null = null;
    if (businessUnitName?.trim()) {
      const bu = await prisma.businessUnit.findUnique({
        where: { name: businessUnitName.trim() },
      });
      if (!bu) {
        res.status(400).json({ error: "Invalid business unit name" });
        return;
      }
      businessUnitId = bu.id;
    } else if (buIdRaw != null && String(buIdRaw).trim() !== "") {
      const id = Number(buIdRaw);
      if (Number.isNaN(id)) {
        res.status(400).json({ error: "Invalid businessUnitId" });
        return;
      }
      const bu = await prisma.businessUnit.findUnique({ where: { id } });
      if (!bu) {
        res.status(400).json({ error: "Invalid businessUnitId" });
        return;
      }
      businessUnitId = id;
    }

    // ---- department ----
    let departmentId: number | null = null;
    if (departmentName?.trim()) {
      const dept = await prisma.department.findUnique({
        where: { name: departmentName.trim() },
      });
      if (!dept) {
        res.status(400).json({ error: "Invalid department name" });
        return;
      }
      departmentId = dept.id;
    } else if (deptIdRaw != null && String(deptIdRaw).trim() !== "") {
      const id = Number(deptIdRaw);
      if (Number.isNaN(id)) {
        res.status(400).json({ error: "Invalid departmentId" });
        return;
      }
      const dept = await prisma.department.findUnique({ where: { id } });
      if (!dept) {
        res.status(400).json({ error: "Invalid departmentId" });
        return;
      }
      departmentId = id;
    }

    // ---- สร้าง user ----
// ---- สร้าง user ----
const hashedPassword = await bcrypt.hash(password, 10);
const profileImagePath = req.file ? normalizeProfilePath(req.file) : null;

const userData: Prisma.UserUncheckedCreateInput = {
  name: name.trim(),
  lastname: (lastname ?? "").toString().trim() || null,
  nickname: (nickname ?? "").toString().trim() || null,
  email: emailNorm,
  password: hashedPassword,
  role: role.trim().toLowerCase(),
  businessUnitId: businessUnitId ?? null,
  departmentId: departmentId ?? null,
  profileImagePath,
  isFirstLogin: true, // Force first-time password change for new users
};

const created = await createUserWithRetry(userData);

    // Note: Notification preferences will be created automatically when:
    // 1. User changes password on first login (primary strategy)
    // 2. User accesses notification preferences page (lazy initialization)
    // This ensures preferences are created at the right time, not during user creation.

    // ตัด password ออกจาก response
    const { password: _pw, profileImagePath: imagePath, ...rest } = created;

    // Log the action
    const actorId = (req as AuthenticatedRequest).user?.id;
    if (actorId) {
      await createAdminLog(
        actorId,
        "USER_CREATE",
        "USER",
        created.id,
        `${created.name} ${created.lastname || ""}`.trim(),
        {
          email: created.email,
          role: created.role,
          lastname: created.lastname,
          nickname: created.nickname,
          businessUnitId: created.businessUnitId,
          businessUnitName: businessUnitName?.trim() || (created.businessUnitId ? (await prisma.businessUnit.findUnique({where: {id: created.businessUnitId}}))?.name : null),
          departmentId: created.departmentId,
          departmentName: departmentName?.trim() || (created.departmentId ? (await prisma.department.findUnique({where: {id: created.departmentId}}))?.name : null),
        }
      );
    }

    res.status(201).json({
      ...rest,
      profileImageUrl: toPublicUrl(imagePath),
    });
  } catch (error) {
    console.error("❌ Failed to create user:", error);
    const { status, error: msg } = mapPrismaError(error);
    res.status(status).json({ error: msg });
  }
};




export const updateUser: RequestHandler = async (req, res) => {
  const id = Number(req.params.id);

  try {
    const existingUser = await prisma.user.findUnique({ where: { id } });
    if (!existingUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const {
      name,
      lastname,
      nickname,
      email,
      password,
      role,
      businessUnitName,
      departmentName,
      businessUnitId: buIdRaw,
      departmentId: deptIdRaw,
      defaultSignatureText,

      // ตัวเลือกเสริม: เคลียร์รูป
      clearImage,
    } = (req.body || {}) as Record<string, any>;

    const updateData: Record<string, any> = {};

    // ชื่อ
    if (typeof name === "string" && name.trim()) {
      updateData.name = name.trim();
    }

    // นามสกุล / ชื่อเล่น: ถ้าส่งมา (แม้เป็นค่าว่าง) จะอัปเดต
    if (lastname !== undefined) {
      updateData.lastname = (lastname ?? "").toString().trim() || null;
    }
    if (nickname !== undefined) {
      updateData.nickname = (nickname ?? "").toString().trim() || null;
    }

    // ลายเซ็นแบบตัวหนังสือเริ่มต้น
    if (defaultSignatureText !== undefined) {
      updateData.defaultSignatureText = (defaultSignatureText ?? "").toString().trim() || null;
    }

    // บทบาท
    if (typeof role === "string" && role.trim()) {
      updateData.role = role.trim().toLowerCase();
    }


    // รหัสผ่าน
    if (typeof password === "string" && password.trim()) {
      updateData.password = await bcrypt.hash(password, 10);
    }

    // อีเมล
    if (typeof email === "string" && email.trim()) {
      const emailNorm = normalizeEmail(email);
      if (emailNorm !== existingUser.email) {
        const dup = await prisma.user.findUnique({
          where: { email: emailNorm },
        });
        if (dup && dup.id !== id) {
          res.status(409).json({ error: "Email already exists" });
          return;
        }
      }
      updateData.email = emailNorm;
    }


    // Business Unit
    if (businessUnitName !== undefined || buIdRaw !== undefined) {
      let businessUnitId: number | null = null;
      if (typeof businessUnitName === "string") {
        const v = businessUnitName.trim();
        if (v) {
          const bu = await prisma.businessUnit.findUnique({
            where: { name: v },
          });
          if (!bu) {
            res.status(400).json({ error: "Invalid business unit name" });
            return;
          }
          businessUnitId = bu.id;
        } else {
          businessUnitId = null;
        }
      } else if (buIdRaw !== undefined) {
        const s = String(buIdRaw).trim();
        if (!s) {
          businessUnitId = null;
        } else {
          const idNum = Number(s);
          if (Number.isNaN(idNum)) {
            res.status(400).json({ error: "Invalid businessUnitId" });
            return;
          }
          const bu = await prisma.businessUnit.findUnique({
            where: { id: idNum },
          });
          if (!bu) {
            res.status(400).json({ error: "Invalid businessUnitId" });
            return;
          }
          businessUnitId = idNum;
        }
      }
      updateData.businessUnitId = businessUnitId;
    }

    // Department
    if (departmentName !== undefined || deptIdRaw !== undefined) {
      let departmentId: number | null = null;
      if (typeof departmentName === "string") {
        const v = departmentName.trim();
        if (v) {
          const dept = await prisma.department.findUnique({
            where: { name: v },
          });
          if (!dept) {
            res.status(400).json({ error: "Invalid department name" });
            return;
          }
          departmentId = dept.id;
        } else {
          departmentId = null;
        }
      } else if (deptIdRaw !== undefined) {
        const s = String(deptIdRaw).trim();
        if (!s) {
          departmentId = null;
        } else {
          const idNum = Number(s);
          if (Number.isNaN(idNum)) {
            res.status(400).json({ error: "Invalid departmentId" });
            return;
          }
          const dept = await prisma.department.findUnique({
            where: { id: idNum },
          });
          if (!dept) {
            res.status(400).json({ error: "Invalid departmentId" });
            return;
          }
          departmentId = idNum;
        }
      }
      updateData.departmentId = departmentId;
    }

    // รูปโปรไฟล์
    if (req.file) {
      updateData.profileImagePath = normalizeProfilePath(req.file);
    } else if (clearImage === "1" || clearImage === true) {
      updateData.profileImagePath = null;
    }

    // อัปเดต
    const updated = await prisma.user.update({
      where: { id },
      data: updateData,
      include: {
        department: true,
        businessUnit: true,
        businessUnitAccess: {
          include: {
            businessUnit: {
              select: { id: true, name: true, abbreviation: true }
            }
          }
        }
      }
    });

    // ไม่คืน password
    const { password: _pw, profileImagePath, ...rest } = updated;

    // Log the action with detailed changes
    const actorId = (req as AuthenticatedRequest).user?.id;
    if (actorId) {
      const changes: Record<string, { old: any; new: any }> = {};

      for (const key of Object.keys(updateData)) {
        let oldValue = (existingUser as any)[key];
        let newValue = updateData[key];

        // Handle specific fields
        if (key === 'password') {
          oldValue = '********';
          newValue = 'CHANGED';
        }

        if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
          changes[key] = { old: oldValue, new: newValue };
        }
      }

      // Add Department/BU name resolution if ID changed
      if (changes.businessUnitId) {
        const oldBu = existingUser.businessUnitId ? await prisma.businessUnit.findUnique({where: {id: existingUser.businessUnitId}}) : null;
        const newBu = updateData.businessUnitId ? await prisma.businessUnit.findUnique({where: {id: updateData.businessUnitId}}) : null;
        changes.businessUnitName = { old: oldBu?.name || null, new: newBu?.name || null };
      }

      if (changes.departmentId) {
        const oldDept = existingUser.departmentId ? await prisma.department.findUnique({where: {id: existingUser.departmentId}}) : null;
        const newDept = updateData.departmentId ? await prisma.department.findUnique({where: {id: updateData.departmentId}}) : null;
        changes.departmentName = { old: oldDept?.name || null, new: newDept?.name || null };
      }

      if (Object.keys(changes).length > 0) {
        await createAdminLog(
          actorId,
          "USER_UPDATE",
          "USER",
          updated.id,
          `${updated.name} ${updated.lastname || ""}`.trim(),
          {
            changes,
          }
        );
      }
    }

    res.json({
      ...rest,
      profileImageUrl: toPublicUrl(profileImagePath),
    });
  } catch (error) {
    console.error("❌ Failed to update user:", error);
    const { status, error: msg } = mapPrismaError(error);
    res.status(status).json({ error: msg });
  }
};

export const deleteUser: RequestHandler = async (req, res) => {
  const id = parseInt(req.params.id as string, 10);

  try {
    const existingUser = await prisma.user.findUnique({ where: { id } });
    if (!existingUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // Check if already deleted
    if (existingUser.deletedAt) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // Soft delete: set deletedAt timestamp
    await prisma.user.update({
      where: { id },
      data: { deletedAt: new Date() }
    });

    // Log the action
    const actorId = (req as AuthenticatedRequest).user?.id;
    if (actorId) {
      await createAdminLog(
        actorId,
        "USER_ARCHIVE",
        "USER",
        existingUser.id,
        `${existingUser.name} ${existingUser.lastname || ""}`.trim(),
        {
          email: existingUser.email,
          role: existingUser.role,
          lastname: existingUser.lastname,
          nickname: existingUser.nickname,
          businessUnitId: existingUser.businessUnitId,
          businessUnitName: existingUser.businessUnitId ? (await prisma.businessUnit.findUnique({where: {id: existingUser.businessUnitId}}))?.name : null,
          departmentId: existingUser.departmentId,
          departmentName: existingUser.departmentId ? (await prisma.department.findUnique({where: {id: existingUser.departmentId}}))?.name : null,
        }
      );
    }

    res.sendStatus(204);
    return;
  } catch (error) {
    console.error("Failed to archive user:", error);
    res.status(500).json({ error: "Failed to archive user" });
    return;
  }
};

export const updateProfileImage: RequestHandler = async (req, res) => {
  const id = parseInt(req.params.id as string, 10);
  if (!req.file || !req.file.filename) {
    res.status(400).json({ error: "No image uploaded" });
    return;
  }
  try {
    const updatedUser = await prisma.user.update({
      where: { id },
      data: { profileImagePath: normalizeProfilePath(req.file) },
      include: { department: true, businessUnit: true },
    });

    const { password, ...safe } = updatedUser as any;
    res.json({
      ...safe,
      profileImageUrl: toPublicUrl(updatedUser.profileImagePath),
    });
  } catch {
    res.status(500).json({ error: "Failed to update profile image" });
  }
};

export const changePassword: RequestHandler = async (req, res) => {
  const id = Number(req.params.id);
  const { current, next } = req.body as { current: string; next: string };

  if (!current || !next) {
    res.status(400).json({ error: "Missing fields" });
    return;
  }

  try {
    // 1) หาผู้ใช้
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // 2) ตรวจสอบรหัสผ่านปัจจุบัน
    const match = await bcrypt.compare(current, user.password);
    if (!match) {
      res.status(401).json({ error: "Current password incorrect" });
      return;
    }

    // 3) Check if this is first login
    const isFirstLogin = user.isFirstLogin === true;

    // 4) hash รหัสผ่านใหม่ แล้วอัพเดต
    const hashed = await bcrypt.hash(next, 10);
    await prisma.user.update({
      where: { id },
      data: { 
        password: hashed,
        isFirstLogin: false // Ensure first login flag is cleared
      },
    });

    // 5) Initialize notification preferences on first password change
    if (isFirstLogin) {
      try {
        const notificationTypes = await prisma.notificationType.findMany();
        
        // Check if user already has preferences (safety check)
        const existingPrefsCount = await prisma.userNotificationPreference.count({
          where: { userId: id }
        });

        if (existingPrefsCount === 0) {
          // Create all preferences with default value (true for all on first login)
          const defaultPreferences = notificationTypes.map(type => ({
            userId: id,
            notificationTypeId: type.id,
            emailEnabled: true // Set everything to true on first login
          }));
          
          await prisma.userNotificationPreference.createMany({
            data: defaultPreferences,
            skipDuplicates: true
          });
          
          console.log(`✅ [First Login] Created ${defaultPreferences.length} notification preferences for user ${id} (all enabled)`);
        } else {
          console.log(`ℹ️  [First Login] User ${id} already has ${existingPrefsCount} preferences, skipping initialization`);
        }
      } catch (prefError) {
        // Log error but don't fail password change
        console.error('⚠️  Failed to initialize notification preferences on first login:', prefError);
      }
    }

    res.json({ message: "Password changed successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
};

// controllers/user.controller.ts// controllers/user.controller.ts
/**
 * Check if an email already exists in the database
 */
export const checkEmailExists: RequestHandler = async (req, res) => {
  const email = String(req.query.email || "")
    .trim()
    .toLowerCase();
  const excludeId = req.query.excludeId
    ? Number(req.query.excludeId)
    : undefined;

  if (!email) {
    res.status(400).json({ error: "Email is required" });
    return;
  }

  try {
    // Find the user with the email
    const user = await prisma.user.findUnique({
      where: { email },
    });

    // Check if the found user is the one being edited (exclude by ID)
    const exists = user ? (excludeId ? user.id !== excludeId : true) : false;

    res.json({ exists });
  } catch (error) {
    console.error("❌ Error checking email existence:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const searchUsers: RequestHandler = async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const limit = Math.min(Number(req.query.limit) || 10, 50);

  const excludeParam = String(req.query.exclude ?? "").trim();
  const excludeIds = excludeParam
    ? excludeParam
        .split(",")
        .map(Number)
        .filter((n) => !isNaN(n))
    : [];

  // If no query provided, return all users (for CC selection enhancement)
  const whereCondition = q
    ? {
        AND: [
          {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
              { nickname: { contains: q, mode: "insensitive" } },
              // Using as any to bypass the type checking issue
              { lastname: { contains: q, mode: "insensitive" } } as any,
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

  const users = (await prisma.user.findMany({
    where: whereCondition,
    include: { department: true },
    orderBy: [{ name: "asc" }, { lastname: "asc" } as any],
    take: q ? limit : Math.min(limit * 2, 100), // Show more users when no query
  })) as Prisma.UserGetPayload<{ include: { department: true } }>[];

  const items = users.map((u: any) => ({
    id: u.id,
    name: u.name,
    lastname: u.lastname ?? null, // 👈 ส่งกลับด้วย
    nickname: u.nickname ?? null,
    email: u.email,
    department: u.department?.name ?? null,
    profileImageUrl: toPublicUrl(u.profileImagePath),
  }));

  res.json(items);
};

// Upload profile image
export const uploadProfileImage: RequestHandler = async (req, res) => {
  try {
    const userId = Number(req.params.id);

    let file: Express.Multer.File | undefined = req.file;
    if (
      !file &&
      req.files &&
      Array.isArray(req.files) &&
      req.files.length > 0
    ) {
      file = req.files[0];
    }
    if (!file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const exists = await prisma.user.findUnique({ where: { id: userId } });
    if (!exists) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    await prisma.user.update({
      where: { id: userId },
      data: { profileImagePath: normalizeProfilePath(file) },
    });

    const updated = await prisma.user.findUnique({
      where: { id: userId },
      include: { department: true, businessUnit: true },
    });

    const { password, ...safe } = updated as any;
    res.json({
      ...safe,
      profileImageUrl: toPublicUrl(updated?.profileImagePath || null),
    });
  } catch (err) {
    console.error("Profile image upload error:", err);
    res.status(500).json({ error: "Failed to upload profile image" });
  }
};

// Get basic user info for multiple users (for approval lines)
export const getUsersBasicInfo: RequestHandler = async (req, res) => {
  try {
    const ids = req.query.ids;
    if (!ids) {
      res.status(400).json({ error: "Missing ids parameter" });
      return;
    }

    // Parse IDs from query parameter (comma-separated)
    const userIds = String(ids)
      .split(",")
      .map(Number)
      .filter((id) => !isNaN(id) && id > 0);

    if (userIds.length === 0) {
      res.status(400).json({ error: "Invalid ids format" });
      return;
    }

    // Limit to prevent abuse
    if (userIds.length > 50) {
      res.status(400).json({ error: "Too many IDs requested" });
      return;
    }

    const users = await prisma.user.findMany({
      where: { 
        id: { in: userIds },
        deletedAt: null
      },
      select: {
        id: true,
        name: true,
        lastname: true,
        nickname: true,
        profileImagePath: true,
      },
    });

    const result = users.map((user: any) => ({
      id: user.id,
      name: user.name,
      lastname: user.lastname ?? null,
      nickname: user.nickname ?? null,
      profileImageUrl: toPublicUrl(user.profileImagePath),
    }));

    res.json(result);
  } catch (error) {
    console.error("Failed to fetch users basic info:", error);
    res.status(500).json({ error: "Failed to fetch users basic info" });
  }
};

// Set user delegation
export const setUserDelegation: RequestHandler = async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { delegatedToUserId, delegationStartDate, delegationEndDate } = req.body;

    // Validate user exists
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // Validate delegated user exists if provided
    if (delegatedToUserId) {
      const delegatedUser = await prisma.user.findUnique({ 
        where: { id: Number(delegatedToUserId) } 
      });
      if (!delegatedUser) {
        res.status(400).json({ error: "Delegated user not found" });
        return;
      }

      // Prevent self-delegation
      if (userId === Number(delegatedToUserId)) {
        res.status(400).json({ error: "Cannot delegate to yourself" });
        return;
      }
    }

    // Validate date range
    if (delegationStartDate && delegationEndDate) {
      const startDate = new Date(delegationStartDate);
      const endDate = new Date(delegationEndDate);
      
      if (startDate >= endDate) {
        res.status(400).json({ error: "Start date must be before end date" });
        return;
      }
    }

    // Update user delegation
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        delegatedToUserId: delegatedToUserId ? Number(delegatedToUserId) : null,
        delegationStartDate: delegationStartDate ? new Date(delegationStartDate) : null,
        delegationEndDate: delegationEndDate ? new Date(delegationEndDate) : null,
      },
      include: {
        delegatedToUser: {
          select: {
            id: true,
            name: true,
            lastname: true,
            nickname: true,
            email: true,
          }
        }
      }
    });

    const { password, ...safeUser } = updatedUser;
    res.json(safeUser);
  } catch (error) {
    console.error("Failed to set user delegation:", error);
    res.status(500).json({ error: "Failed to set user delegation" });
  }
};

// Get user delegation info
export const getUserDelegation: RequestHandler = async (req, res) => {
  try {
    const userId = Number(req.params.id);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        delegatedToUser: {
          select: {
            id: true,
            name: true,
            lastname: true,
            nickname: true,
            email: true,
          }
        }
      }
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const delegation = {
      delegatedToUser: user.delegatedToUser,
      delegationStartDate: user.delegationStartDate,
      delegationEndDate: user.delegationEndDate,
      isCurrentlyDelegated: user.delegatedToUserId && user.delegationStartDate && user.delegationEndDate
        ? new Date() >= user.delegationStartDate && new Date() <= user.delegationEndDate
        : false
    };

    res.json(delegation);
  } catch (error) {
    console.error("Failed to get user delegation:", error);
    res.status(500).json({ error: "Failed to get user delegation" });
  }
};

// Clear user delegation
export const clearUserDelegation: RequestHandler = async (req, res) => {
  try {
    const userId = Number(req.params.id);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        delegatedToUserId: null,
        delegationStartDate: null,
        delegationEndDate: null,
      }
    });

    const { password, ...safeUser } = updatedUser;
    res.json(safeUser);
  } catch (error) {
    console.error("Failed to clear user delegation:", error);
    res.status(500).json({ error: "Failed to clear user delegation" });
  }
};

// ============================================================================
// Notification Preferences
// ============================================================================

import {
  getUserNotificationPreferences,
  updateNotificationPreference,
  updateAllNotificationPreferences
} from '../lib/notificationPreferences';

/**
 * GET /api/users/me/notification-preferences
 * Get current user's notification preferences
 */
export const getNotificationPreferences: RequestHandler = async (req, res) => {
  try {
    const userId = req.user?.id;
    
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const preferences = await getUserNotificationPreferences(userId);
    res.json({ preferences });
  } catch (error) {
    console.error('Error getting notification preferences:', error);
    res.status(500).json({ error: 'Failed to get notification preferences' });
  }
};

/**
 * PUT /api/users/me/notification-preferences/:typeId
 * Update a single notification preference
 */
export const updateSingleNotificationPreference: RequestHandler = async (req, res) => {
  try {
    const userId = req.user?.id;
    
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const notificationTypeId = Number(req.params.typeId);
    const { emailEnabled } = req.body;

    if (typeof emailEnabled !== 'boolean') {
      res.status(400).json({ error: 'emailEnabled must be a boolean' });
      return;
    }

    if (isNaN(notificationTypeId)) {
      res.status(400).json({ error: 'Invalid notification type ID' });
      return;
    }

    const preference = await updateNotificationPreference(
      userId,
      notificationTypeId,
      emailEnabled
    );

    res.json({
      success: true,
      preference: {
        notificationTypeId: preference.notificationTypeId,
        emailEnabled: preference.emailEnabled
      }
    });
  } catch (error: any) {
    console.error('Error updating notification preference:', error);
    
    if (error.message === 'Notification type not found') {
      res.status(400).json({ error: 'Invalid notification type' });
      return;
    }
    
    res.status(500).json({ error: 'Failed to update notification preference' });
  }
};

/**
 * PUT /api/users/me/notification-preferences/bulk
 * Update all notification preferences at once
 */
export const updateBulkNotificationPreferences: RequestHandler = async (req, res) => {
  try {
    const userId = req.user?.id;
    
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { emailEnabled } = req.body;

    if (typeof emailEnabled !== 'boolean') {
      res.status(400).json({ error: 'emailEnabled must be a boolean' });
      return;
    }

    const result = await updateAllNotificationPreferences(userId, emailEnabled);

    res.json({
      success: true,
      updatedCount: result.updatedCount
    });
  } catch (error) {
    console.error('Error updating bulk notification preferences:', error);
    res.status(500).json({ error: 'Failed to update notification preferences' });
  }
};

/**
 * Force user to reset password on next login
 */
export const forcePasswordReset: RequestHandler = async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const actorId = (req as AuthenticatedRequest).user?.id;

    if (!actorId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Check if user exists
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, deletedAt: true }
    });

    if (!user || user.deletedAt) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Update isFirstLogin to true
    await prisma.user.update({
      where: { id: userId },
      data: { isFirstLogin: true }
    });

    // Log the action
    await createAdminLog(
      actorId,
      'USER_FORCE_PASSWORD_RESET',
      'USER',
      userId,
      `${user.name} (${user.email})`,
      {
        action: 'Force password reset on next login'
      }
    );

    res.json({ 
      success: true, 
      message: 'User will be required to reset password on next login' 
    });
  } catch (error) {
    console.error('Error forcing password reset:', error);
    res.status(500).json({ error: 'Failed to force password reset' });
  }
};

/**
 * Clear first-time login flag (set isFirstLogin to false)
 */
export const clearFirstLogin: RequestHandler = async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const actorId = (req as AuthenticatedRequest).user?.id;

    if (!actorId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Check if user exists
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, deletedAt: true }
    });

    if (!user || user.deletedAt) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Update isFirstLogin to false
    await prisma.user.update({
      where: { id: userId },
      data: { isFirstLogin: false }
    });

    // Log the action
    await createAdminLog(
      actorId,
      'USER_CLEAR_FIRST_LOGIN',
      'USER',
      userId,
      `${user.name} (${user.email})`,
      {
        action: 'Clear first-time login flag'
      }
    );

    res.json({ 
      success: true, 
      message: 'First-time login flag cleared successfully' 
    });
  } catch (error) {
    console.error('Error clearing first-time login:', error);
    res.status(500).json({ error: 'Failed to clear first-time login flag' });
  }
};
