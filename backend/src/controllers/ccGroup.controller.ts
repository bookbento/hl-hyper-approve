import { RequestHandler } from "express";
import { prisma } from "../../prisma/client";
import { AuthenticatedRequest } from "../types/request";
import { Prisma } from "@prisma/client";
import { createAdminLog } from "./adminLog.controller";

const isAdminOrDcc = (req: AuthenticatedRequest) => {
  const r = (req.user?.role ?? "").toString().toUpperCase();
  const roles = ((req.user as any)?.roles ?? []).map((x: string) =>
    x?.toString?.().toUpperCase?.()
  );

  return (
    r === "ADMIN" ||
    r === "DCC" ||
    roles.includes("ADMIN") ||
    roles.includes("DCC")
  );
};


const assertOwnerOrAdmin = async (req: AuthenticatedRequest, groupId: number) => {
  const g = await prisma.ccGroup.findUnique({
    where: { id: groupId },
    select: { ownerId: true },
  });
  if (!g) {
    const e = new Error("Group not found");
    (e as any).status = 404;
    throw e;
  }
  // ✅ ถ้าไม่ใช่ Admin/DCC และไม่ใช่ owner → ห้าม
  if (!isAdminOrDcc(req) && g.ownerId !== req.user!.id) {
    const e = new Error("Forbidden");
    (e as any).status = 403;
    throw e;
  }
};


export const listMyGroups: RequestHandler = async (req: AuthenticatedRequest, res) => {
  const ownerId = req.user!.id;

  const where: Prisma.CcGroupWhereInput = isAdminOrDcc(req)
    ? {}                 // ✅ ถ้าเป็น Admin หรือ DCC → เห็นทุกกลุ่ม
    : { ownerId };       // 👤 user ปกติ → เห็นเฉพาะกลุ่มที่ตัวเองเป็น owner

  const rows = await prisma.ccGroup.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    include: {
      members: {
        include: {
          user: { 
            select: { 
              id: true, 
              name: true, 
              lastname: true, 
              nickname: true, 
              email: true,
              profileImagePath: true,
              department: { select: { id: true, name: true } },
              businessUnit: { select: { id: true, name: true } }
            } 
          },
        },
      },
    },
  });

  res.json(
    rows.map((g) => ({
      id: g.id,
      name: g.name,
      members: g.members.map((m) => ({
        id: m.user.id,
        userId: m.userId,
        name: m.user.name,
        lastname: m.user.lastname,
        nickname: m.user.nickname,
        email: m.user.email,
        profileImagePath: m.user.profileImagePath,
        department: m.user.department,
        businessUnit: m.user.businessUnit,
      })),
    }))
  );
};


export const createGroup: RequestHandler = async (req: AuthenticatedRequest, res) => {
  const ownerId = req.user!.id;
  const name = String(req.body.name || "").trim();
  const memberIds: number[] = Array.isArray(req.body.memberIds) ? req.body.memberIds.map(Number) : [];

  if (!name) { res.status(400).json({ error: "Group name is required" }); return; }

  try {
    const group = await prisma.ccGroup.create({
      data: {
        name, ownerId,
        members: memberIds.length ? {
          createMany: {
            data: [...new Set(memberIds)].map(uid => ({ userId: uid }))
          }
        } : undefined
      },
      include: { members: true }
    });

    // Log the action
    // Log the action
    // Fetch initial member names
    let memberNames: string[] = [];
    if (memberIds.length) {
      const users = await prisma.user.findMany({
        where: { id: { in: [...new Set(memberIds)] } },
        select: { id: true, name: true, lastname: true, email: true }
      });
      memberNames = users.map(u => `${u.name} ${u.lastname || ""}`.trim() || u.email);
    }

    await createAdminLog(
      ownerId,
      "CC_GROUP_CREATE",
      "CC_GROUP",
      group.id,
      group.name,
      { members: memberNames }
    );

    res.status(201).json({ id: group.id, name: group.name, memberCount: group.members.length });
  } catch (e: any) {
    if (String(e?.code) === "P2002") {
      res.status(409).json({ error: "You already have a group with this name" }); return;
    }
    console.error(e); res.status(500).json({ error: "Failed to create group" });
  }
};

export const getGroup: RequestHandler = async (req: AuthenticatedRequest, res) => {
  const id = Number(req.params.id);
  await assertOwnerOrAdmin(req, id);
  const g = await prisma.ccGroup.findUnique({
    where: { id },
    include: { 
      members: { 
        include: { 
          user: { 
            select: { 
              id: true, 
              name: true, 
              lastname: true, 
              nickname: true, 
              email: true,
              profileImagePath: true,
              department: { select: { id: true, name: true } },
              businessUnit: { select: { id: true, name: true } }
            } 
          } 
        } 
      } 
    }
  });
  res.json({
    id: g!.id,
    name: g!.name,
    members: g!.members.map(m => ({ 
      id: m.user.id,
      userId: m.userId, 
      name: m.user.name, 
      lastname: m.user.lastname,
      nickname: m.user.nickname,
      email: m.user.email,
      profileImagePath: m.user.profileImagePath,
      department: m.user.department,
      businessUnit: m.user.businessUnit,
    }))
  });
};

export const renameGroup: RequestHandler = async (req: AuthenticatedRequest, res) => {
  const id = Number(req.params.id);
  await assertOwnerOrAdmin(req, id);
  const name = String(req.body.name || "").trim();
  if (!name) { res.status(400).json({ error: "Group name is required" }); return; }
  try {
    const oldGroup = await prisma.ccGroup.findUnique({ where: { id } });
    const u = await prisma.ccGroup.update({ where: { id }, data: { name } });

    // Log the action
    const actorId = req.user?.id;
    if (actorId && oldGroup?.name !== u.name) {
      await createAdminLog(
        actorId,
        "CC_RENAME",
        "CC_GROUP",
        u.id,
        u.name,
        { oldName: oldGroup?.name, newName: u.name }
      );
    }

    res.json({ id: u.id, name: u.name });
  } catch (e: any) {
    if (String(e?.code) === "P2002") {
      res.status(409).json({ error: "You already have a group with this name" }); return;
    }
    console.error(e); res.status(500).json({ error: "Failed to rename group" });
  }
};

export const replaceGroupMembers: RequestHandler = async (req: AuthenticatedRequest, res) => {
  const id = Number(req.params.id);
  await assertOwnerOrAdmin(req, id);
  const userIds: number[] = Array.isArray(req.body.userIds) ? req.body.userIds.map(Number).filter((n: number) => isFinite(n) && n > 0) : [];
  const uniq = [...new Set(userIds)];

  // Validate that all user IDs exist in the database
  const existingUsers = await prisma.user.findMany({
    where: { id: { in: uniq } },
    select: { id: true }
  });
  const validUserIds = existingUsers.map(u => u.id);
  const invalidUserIds = uniq.filter(uid => !validUserIds.includes(uid));
  
  if (invalidUserIds.length > 0) {
    console.warn(`replaceGroupMembers: Invalid user IDs filtered out: ${invalidUserIds.join(', ')}`);
  }

  // Fetch existing members
  const currentMembers = await prisma.ccGroupMember.findMany({
    where: { groupId: id },
    select: { userId: true }
  });
  const currentMemberIds = currentMembers.map(m => m.userId);

  // Compare sets using only valid user IDs
  const oldSet = new Set(currentMemberIds);
  const newSet = new Set(validUserIds);
  
  let hasChanged = false;
  if (oldSet.size !== newSet.size) {
    hasChanged = true;
  } else {
    for (const uid of newSet) {
      if (!oldSet.has(uid)) {
        hasChanged = true;
        break;
      }
    }
  }

  await prisma.$transaction(async (tx) => {
    // Optimization: only update if changed? 
    // actually user might want to re-save to be sure. 
    // But to fix logging issue, we can just use the hasChanged flag for logging.
    
    // NOTE: The original code always deletes and inserts. We keep that logic to ensure consistency, 
    // but we use the pre-calculated difference for logging.
    await tx.ccGroupMember.deleteMany({ where: { groupId: id } });
    if (validUserIds.length) {
      await tx.ccGroupMember.createMany({
        data: validUserIds.map(uid => ({ groupId: id, userId: uid })),
        skipDuplicates: true
      });
    }
  });

  const count = await prisma.ccGroupMember.count({ where: { groupId: id } });

  // Log the action ONLY if members actually changed
  const actorId = req.user?.id;
  if (actorId && hasChanged) {
    const group = await prisma.ccGroup.findUnique({ where: { id }, select: { name: true } });
    
    // Fetch all relevant users (old + new) to map names
    const allRelevantIds = Array.from(new Set([...currentMemberIds, ...validUserIds]));
    const allUsers = await prisma.user.findMany({
      where: { id: { in: allRelevantIds } },
      select: { id: true, name: true, lastname: true, email: true }
    });
    
    const userMap = new Map(allUsers.map(u => [u.id, u]));
    const getName = (uid: number) => {
      const u = userMap.get(uid);
      return u ? `${u.name} ${u.lastname || ""}`.trim() || u.email : `ID:${uid}`;
    };

    const oldMemberNames = currentMemberIds.map(getName);
    const newMemberNames = validUserIds.map(getName);
    const addedNames = validUserIds.filter(x => !oldSet.has(x)).map(getName);
    const removedNames = currentMemberIds.filter(x => !newSet.has(x)).map(getName);

    await createAdminLog(
      actorId,
      "CC_UPDATE_MEMBERS",
      "CC_GROUP",
      id,
      group?.name ?? "",
      { 
        old_members: oldMemberNames,
        new_members: newMemberNames,
        added: addedNames,
        removed: removedNames
      }
    );
  }

  res.json({ id, memberCount: count });
};

export const deleteGroup: RequestHandler = async (req: AuthenticatedRequest, res) => {
  const id = Number(req.params.id);
  await assertOwnerOrAdmin(req, id);

  // Get group info before deletion for logging
  const group = await prisma.ccGroup.findUnique({
    where: { id },
    include: { 
      members: {
        include: {
          user: { select: { id: true, name: true, lastname: true, email: true } }
        }
      } 
    }
  });

  await prisma.ccGroup.delete({ where: { id } });

  // Log the action
  const actorId = req.user?.id;
  if (actorId && group) {
    const memberNames = group.members.map(m => {
      const u = m.user;
      return `${u.name} ${u.lastname || ""}`.trim() || u.email;
    });

    await createAdminLog(
      actorId,
      "CC_GROUP_DELETE",
      "CC_GROUP",
      id,
      group.name,
      { members: memberNames }
    );
  }

  res.json({ ok: true });
};


export const searchCcGroups: RequestHandler = async (req, res) => {
  try {
    const qRaw = String(req.query.q ?? "").trim();
    const limitRaw = parseInt(String(req.query.limit ?? "10"), 10);
    const limit = Math.max(1, Math.min(isFinite(limitRaw) ? limitRaw : 10, 50));

    const where =
      qRaw.length > 0
        ? { name: { contains: qRaw, mode: "insensitive" as const } }
        : {};

    // 👇 กำหนด include และใช้มันสร้าง type ที่ตรงกับ payload
const include = {
  _count: { select: { members: true } },
  members: {
    // ❌ ลบ take: 3 ทิ้ง
    include: {
      user: {
        select: {
          id: true,
          name: true,
          lastname: true,
          nickname: true,
          email: true,
          profileImagePath: true,
          department: { select: { name: true } },
        },
      },
    },
  },
} satisfies Prisma.CcGroupInclude;


    type CcGroupSearchRow = Prisma.CcGroupGetPayload<{ include: typeof include }>;

    const groups: CcGroupSearchRow[] = await prisma.ccGroup.findMany({
      where,
      take: limit,
      orderBy: { name: "asc" },
      include,
    });

const payload = groups.map((g) => ({
  id: g.id,
  name: g.name,
  memberCount: g._count.members,
  memberIds: g.members.map((m) => m.userId),        // ✅ เพิ่มบรรทัดนี้
  previewMembers: g.members.map((m) => ({
    id: m.user.id,
    name: m.user.name,
    lastname: m.user.lastname,
    nickname: m.user.nickname,
    email: m.user.email,
    profileImagePath: m.user.profileImagePath ?? null,
    team: null as string | null,
    department: m.user.department?.name ?? null,
  })),
}));


    res.json(payload);
  } catch (err: any) {
    console.error("searchCcGroups error:", err);
    res.status(500).json({ error: "Failed to search CC groups" });
  }
};

export const getGroupsBasicInfo: RequestHandler = async (req, res) => {
  try {
    const idsParam = String(req.query.ids ?? "").trim();
    if (!idsParam) {
      res.json([]);
      return;
    }

    const ids = idsParam
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => isFinite(n) && n > 0);

    if (ids.length === 0) {
      res.json([]);
      return;
    }

    const groups = await prisma.ccGroup.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        members: {
          select: { userId: true },
        },
      },
    });

    const payload = groups.map((g) => ({
      id: g.id,
      name: g.name,
      memberIds: g.members.map((m) => m.userId),
    }));

    res.json(payload);
  } catch (err: any) {
    console.error("getGroupsBasicInfo error:", err);
    res.status(500).json({ error: "Failed to fetch groups basic info" });
  }
};

export const bulkUpdateMembers: RequestHandler = async (req: AuthenticatedRequest, res) => {
  const { action, fromUserId, toUserId, groupIds } = req.body;
  const actorId = req.user!.id;

  if (!action || !['replace', 'remove'].includes(action)) {
    res.status(400).json({ error: "Invalid action. Must be 'replace' or 'remove'" });
    return;
  }
  if (!fromUserId) {
    res.status(400).json({ error: "fromUserId is required" });
    return;
  }
  if (action === "replace" && !toUserId) {
    res.status(400).json({ error: "toUserId is required for replace action" });
    return;
  }
  if (!Array.isArray(groupIds) || groupIds.length === 0) {
    res.status(400).json({ error: "groupIds must be a non-empty array" });
    return;
  }

  try {
    // Only process groups the user has permission to edit
    const groups = await prisma.ccGroup.findMany({
      where: {
        id: { in: groupIds.map(Number) },
        ...(!isAdminOrDcc(req) ? { ownerId: actorId } : {})
      },
      select: { id: true, name: true }
    });

    const validGroupIds = groups.map(g => g.id);
    if (validGroupIds.length === 0) {
      res.status(403).json({ error: "No valid groups found or permission denied" });
      return;
    }

    let changedCount = 0;

    await prisma.$transaction(async (tx) => {
      for (const groupId of validGroupIds) {
        // Using deleteMany to avoid errors if the record doesn't exist
        const deleteResult = await tx.ccGroupMember.deleteMany({
          where: { groupId, userId: Number(fromUserId) }
        });

        if (deleteResult.count > 0) {
          if (action === "replace") {
            const newMemberId = Number(toUserId);
            // Try to add new member (skipDuplicates: true prevents constraint error)
            await tx.ccGroupMember.createMany({
              data: [{ groupId, userId: newMemberId }],
              skipDuplicates: true
            });
          }
          changedCount++;
        }
      }
    });

    // Logging
    if (changedCount > 0) {
      const users = await prisma.user.findMany({
        where: { id: { in: action === "replace" ? [Number(fromUserId), Number(toUserId)] : [Number(fromUserId)] } },
        select: { id: true, name: true, lastname: true, email: true }
      });
      const userMap = new Map((users).map((u) => [u.id, u]));
      
      const getName = (uid: number) => {
        const u = userMap.get(uid);
        return u ? `${u.name} ${u.lastname || ""}`.trim() || u.email : `ID:${uid}`;
      };

      const fromName = getName(Number(fromUserId));
      const toName = action === "replace" ? getName(Number(toUserId)) : null;

      const groupNames = groups.map(g => g.name);

      await createAdminLog(
        actorId,
        action === "replace" ? "CC_GROUP_BULK_REPLACE" : "CC_GROUP_BULK_REMOVE",
        "CC_GROUP",
        validGroupIds[0], // Associate with the first group id for logging
        `Bulk update on ${validGroupIds.length} groups`,
        { 
          action,
          groupsAffected: validGroupIds.length,
          groupNames,
          fromUser: fromName,
          ...(toName ? { toUser: toName } : {})
        }
      );
    }

    res.json({ ok: true, groupsUpdated: validGroupIds.length, changedCount });
  } catch (err) {
    console.error("bulkUpdateMembers error:", err);
    res.status(500).json({ error: "Failed to perform bulk update" });
  }
};