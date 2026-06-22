/**
 * memoComment.service.ts
 *
 * Wave 3 extraction: ฟังก์ชัน Comment ทั้งหมดย้ายมาจาก memo.controller.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Exported handlers (RequestHandler):
 *   getCommentsByMemoId
 *   addCommentToMemo
 *   deleteComment
 *
 * Exported async helpers:
 *   sendCommentEmailsAsync
 *   sendDeleteCommentEmailsAsync
 *
 * Private (module-level) builders:
 *   buildCommentPlain / buildCommentHtml
 *   buildDeleteCommentPlain / buildDeleteCommentHtml
 */

import { RequestHandler } from "express";
import { prisma } from "../../prisma/client";
import fs from "fs";
import path from "path";
import { ActionType } from "@prisma/client";
import { makeEmailToken } from "../lib/token";
import { sendEmail } from "../lib/mailer";
import { UPLOADS_DIR } from "../middlewares/upload";
import { decodeFilename } from "../lib/filename";
import { filterUsersForEmail } from "../lib/notificationPreferences";

/* ───── FRONTEND_URL guard ───── */
if (!process.env.FRONTEND_URL) {
  throw new Error("Environment variable FRONTEND_URL is not set");
}
const FRONTEND_URL: string = process.env.FRONTEND_URL as string;

/* =========================================================================
   GET /api/memos/:id/comments
   ========================================================================= */
export const getCommentsByMemoId: RequestHandler = async (req, res) => {
  const memoId = Number(req.params.id);
  if (isNaN(memoId)) {
    res.status(400).json({ error: "Invalid memo ID" });
    return;
  }
  try {
    const comments = await prisma.comment.findMany({
      where: { memoId },
      include: {
        user: { select: { id: true, name: true, profileImagePath: true } },
        extraUser: { select: { name: true, lastname: true, nickname: true } }, // ✅ Include extraUser
        attachments: true,
        tags: {
          select: {
            id: true,
            user: { select: { id: true, name: true, lastname: true, nickname: true } },
          },
        }, // ✅ Include tags and user details to check if it's a mention
      },
      orderBy: { createdAt: "asc" },
    });

    const host = `${req.protocol}://${req.get("host")}`;
    const normalize = (p: string) =>
      p.startsWith("/api/uploads") ? p.replace(/^\/api/, "") : p;

    const payload = comments.map((c) => ({
      id: c.id,
      comment: c.comment,
      isRecallExtra: c.isRecallExtra, // ✅ ส่ง field ไปด้วย
      ExtraUserid: c.ExtraUserid,
      ExtraStatus: c.ExtraStatus,
      extraApprovalLineId: c.extraApprovalLineId,
      createdAt: c.createdAt,
      extraUser: c.extraUser, // ✅ ส่ง user ของ extra approver กลับไป
      hasMentions: c.tags && c.tags.length > 0, // ✅ Check if comment has any mention tags
      tags: c.tags.map((t) => t.user), // ✅ Send mentioned users to frontend
      user: {
        id: c.user.id,
        name: c.user.name,
        profileImage: c.user.profileImagePath
          ? `/uploads/profiles/${c.user.profileImagePath}`
          : null,
      },
      attachments: c.attachments.map((att) => {
        // normalize ให้เป็น "/uploads/..." เสมอ
        const pathNormalized = att.url.startsWith("/api/uploads")
          ? att.url.replace(/^\/api/, "") // => "/uploads/..."
          : att.url; // เดิมก็ "/uploads/..."

        return {
          id: att.id,
          // ✅ สำคัญ: encodeURI กันช่องว่าง/อักขระพิเศษ
          url: `${host}${encodeURI(pathNormalized)}`,
          filename: att.filename,
          mimetype: att.mimetype,
        };
      }),
    }));

    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch comments" });
  }
};

/* =========================================================================
   POST /api/memos/:id/comments
   ========================================================================= */
export const addCommentToMemo: RequestHandler = async (req, res) => {
  const memoId = Number(req.params.id);
  const userId = req.user!.id;
  const content = ((req.body.content as string) || "").trim();
  const files = (req.files as Express.Multer.File[]) || [];
  const hasFile = files.length > 0 || !!req.file;

  if (isNaN(memoId)) {
    res.status(400).json({ error: "Invalid memo ID" });
    return;
  }
  if (!content && !hasFile) {
    res.status(400).json({ error: "Comment or attachment is required" });
    return;
  }

  try {
    // 1) สถานะล่าสุด (เงียบ: Draft/Recall)
    const latestPivot = await prisma.memoStatusPivot.findFirst({
      where: { memoId },
      orderBy: { createdAt: "desc" },
      include: { status: { select: { id: true, name: true } } },
    });
    const SILENT_STATUS_IDS = new Set([1, 6]);
    const SILENT_STATUS_NAMES = new Set(["draft", "recalled"]);
    const currentStatusId = latestPivot?.status?.id ?? null;
    const currentStatusName = (latestPivot?.status?.name ?? "").toLowerCase();
    const isSilent =
      currentStatusId === null ||
      SILENT_STATUS_IDS.has(currentStatusId) ||
      SILENT_STATUS_NAMES.has(currentStatusName);

    // 2) สร้าง comment
    const comment = await prisma.comment.create({
      data: { memoId, userId, comment: content },
    });

    // 3) แนบไฟล์ (ถ้ามี)
    if (files.length > 0) {
      const commentsDir = path.join(UPLOADS_DIR, "comments");
      fs.mkdirSync(commentsDir, { recursive: true });

      for (const file of files) {
        // Multer acts as storage engine, so file is already in "uploads/comments" (or target dir)
        // with a generated filename. We just need to save the reference.
        // file.filename = "TIMESTAMP-safeName"
        // file.path = "uploads/comments/TIMESTAMP-safeName" (absolute or relative depending on config)

        const { filename: diskName, mimetype, size, originalname } = file;
        const originalUtf8 = decodeFilename(originalname);

        // We don't need to rename/move because middleware/upload.ts already puts it in COMMENTS_DIR
        // with ${Date.now()}-${safeName} format.

        await prisma.commentAttachment.create({
          data: {
            commentId: comment.id,
            url: `/uploads/comments/${diskName}`, // Assumes standard multer storage path
            filename: originalUtf8,
            mimetype,
            size,
          },
        });
      }
    }

    // 4) parse mentions และสร้าง commentTag
    const rawMentions =
      (req.body as any).mentionUserIds ?? (req.body as any).mentions;
    let mentionUserIds: number[] = [];
    try {
      const parsed =
        typeof rawMentions === "string" ? JSON.parse(rawMentions) : rawMentions;
      const arr = Array.isArray(parsed) ? parsed : [];
      mentionUserIds = Array.from(
        new Set(
          arr
            .map((x: any) => Number(x))
            .filter((n: number) => Number.isFinite(n) && n > 0 && n !== userId),
        ),
      );
    } catch {
      mentionUserIds = [];
    }

    if (mentionUserIds.length) {
      await prisma.commentTag.createMany({
        data: mentionUserIds.map((uid) => ({
          memoId,
          commentId: comment.id,
          userId: uid,
        })),
        skipDuplicates: true,
      });
    }

    // 5) โหลดข้อมูล comment ที่จะตอบกลับ
    const full = await prisma.comment.findUnique({
      where: { id: comment.id },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            lastname: true,
            profileImagePath: true,
          },
        },
        attachments: true,
      },
    });
    if (!full) {
      res.status(500).json({ error: "Failed to add comment" });
      return;
    }

    // util แสดงชื่อ
    const fmtName = (u: {
      name?: string | null;
      lastname?: string | null;
      nickname?: string | null;
    }) => {
      const base = [u.name, u.lastname].filter(Boolean).join(" ").trim();
      return u.nickname ? `${base} (${u.nickname})` : base || u.name || "";
    };

    // 6) History: บันทึกการคอมเมนต์
    await prisma.memoHistory.create({
      data: {
        memoId,
        userId,
        statusId: currentStatusId,
        action: `${full.user.name} ${
          full.user.lastname ?? ""
        } commented on the memo`,
        actiontype: ActionType.COMMENT,
        timestamp: new Date(),
      },
    });

    // 7) History: บันทึก "ใครกล่าวถึงใคร"
    if (mentionUserIds.length) {
      const mentionedUsers = await prisma.user.findMany({
        where: { id: { in: mentionUserIds } },
        select: { name: true, lastname: true, nickname: true },
      });
      const targetNames = mentionedUsers.map(fmtName);
      const actorName = fmtName({
        name: full.user.name,
        lastname: full.user.lastname,
      });
      const oxfordJoin = (xs: string[]) =>
        xs.length <= 1
          ? xs[0] || ""
          : xs.length === 2
            ? `${xs[0]} and ${xs[1]}`
            : `${xs.slice(0, -1).join(", ")}, and ${xs[xs.length - 1]}`;

      await prisma.memoHistory.create({
        data: {
          memoId,
          userId,
          action: `${actorName} mentioned ${oxfordJoin(
            targetNames,
          )} in a comment`,
          actiontype: ActionType.UPDATE,
          timestamp: new Date(),
        },
      });
    }

    // 8) แจ้งเตือน/อีเมล (เฉพาะถ้าไม่ใช่ Draft/Recall)
    if (!isSilent) {
      const memoRec = await prisma.masterMemo.findUnique({
        where: { id: memoId },
        select: { userId: true, subject: true, memonumber: true },
      });

      if (memoRec) {
        // ฐานผู้รับ: owner + approver(เวอร์ชันล่าสุด) + CC
        const baseRecipients = new Set<number>([memoRec.userId]);
        const { _max } = await prisma.memoApproverAction.aggregate({
          where: { memoId },
          _max: { version: true },
        });
        const latestVer = _max.version ?? 1;

        // แจ้งเตือนแค่ Owner + ยูสเซอร์ที่ถูก Mention
        const mentionRecipients = new Set<number>(mentionUserIds);
        mentionRecipients.delete(userId); // กันคนคอมเมนต์ออก

        const ownerId = memoRec.userId;
        const others = new Set<number>();
        if (ownerId && ownerId !== userId && !mentionRecipients.has(ownerId)) {
          others.add(ownerId);
        }

        // โหลดชื่อคนที่ถูก tag เพื่อส่งไปในเมล/โนติ
        const mentionedUsersList = await prisma.user.findMany({
          where: { id: { in: Array.from(mentionRecipients) } },
          select: { name: true, lastname: true, nickname: true },
        });
        const mentionedNames = mentionedUsersList.map((u) => fmtName(u));

        // In-app notifications
        const subj = memoRec.subject ?? String(memoId);
        const actorDisp = fmtName({
          name: full.user.name,
          lastname: full.user.lastname,
        });

        // Use filterUsersForEmail to respect user notification preferences
        const mentionUsersArr = Array.from(mentionRecipients);
        const othersArr = Array.from(others);

        // Map mentions
        const taggedUsers = await filterUsersForEmail(
          mentionUsersArr,
          "tagged-in-comment",
        );

        const notifyMentions = new Set(taggedUsers);

        // Map others
        let othersNotificationSlug = "new-comment";
        if (mentionedNames && mentionedNames.length > 0) {
          othersNotificationSlug = "others-mentioned";
        }

        const notifyOthersFilter = await filterUsersForEmail(
          othersArr,
          othersNotificationSlug,
        );
        const notifyOthers = new Set(notifyOthersFilter);

        const buildNoti = (uid: number, message: string) => ({
          memoId,
          userId: uid,
          actorId: userId,
          notificationTypeId: 2, // 2 = comment
          message,
          commentId: comment.id,
        });

        const notis: any[] = [];

        for (const uid of mentionRecipients) {
          if (notifyMentions.has(uid)) {
            notis.push(
              buildNoti(
                uid,
                `You were mentioned in memo "${subj}" by ${actorDisp}.`,
              ),
            );
          }
        }

        for (const uid of others) {
          if (notifyOthers.has(uid)) {
            if (mentionedNames.length > 0) {
              notis.push(
                buildNoti(
                  uid,
                  `${actorDisp} mentioned ${mentionedNames.join(", ")} in a comment on "${subj}".`,
                ),
              );
            } else {
              notis.push(
                buildNoti(uid, `New comment in memo "${subj}" by ${actorDisp}.`),
              );
            }
          }
        }
        if (notis.length) await prisma.notification.createMany({ data: notis });

        // Email: ใช้ helper เท่านั้น (อย่าเรียก sendEmail ตรง ๆ)
        const memoNumber = memoRec.memonumber ?? memoId;
        const snippet = content ? content.slice(0, 120) : "[attachment]";

        const mentionList = [...mentionRecipients];
        if (mentionList.length) {
          await sendCommentEmailsAsync({
            receiverIds: mentionList,
            memoSubject: subj,
            memoNumber: memoNumber,
            memoId,
            commenter: actorDisp,
            snippet,
            isMention: true,
            mentionedNames,
          });
        }
        if (others.size) {
          await sendCommentEmailsAsync({
            receiverIds: Array.from(others),
            memoSubject: subj,
            memoNumber: memoNumber,
            memoId,
            commenter: actorDisp,
            snippet,
            isMention: false,
            mentionedNames,
          });
        }
      }
    }

    // 9) ตอบกลับ FE
    const host = `${req.protocol}://${req.get("host")}`;
    const normalize = (p: string) =>
      p.startsWith("/api/uploads") ? p.replace(/^\/api/, "") : p;

    res.status(201).json({
      id: full.id,
      comment: full.comment,
      createdAt: full.createdAt,
      user: {
        id: full.user.id,
        name: full.user.name,
        lastname: full.user.lastname,
        profileImage: full.user.profileImagePath
          ? `/uploads/profiles/${full.user.profileImagePath}`
          : null,
      },
      attachments: full.attachments.map((a) => {
        const pathNormalized = normalize(a.url);
        return {
          id: a.id,
          url: `${host}${encodeURI(pathNormalized)}`,
          filename: a.filename,
          mimetype: a.mimetype,
        };
      }),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to add comment" });
  }
};

/* =========================================================================
   DELETE /api/comments/:commentId
   ========================================================================= */
export const deleteComment: RequestHandler = async (req, res) => {
  const commentId = Number(req.params.commentId);
  if (isNaN(commentId)) {
    res.status(400).json({ error: "Invalid comment ID" });
    return;
  }
  try {
    // Prevent deleting regular comments. Only allow deleting mentions.
    const commentData = await prisma.comment.findUnique({
      where: { id: commentId },
      include: {
        memo: { select: { subject: true, memonumber: true, userId: true } },
        tags: { select: { userId: true } },
        user: { select: { name: true, lastname: true } },
      },
    });

    if (!commentData) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }

    if (commentData.tags.length === 0) {
      res
        .status(403)
        .json({ error: "Only comments with mentions can be deleted." });
      return;
    }

    const { memo, tags, user: commenter } = commentData;
    const memoId = commentData.memoId;
    const actorId = req.user!.id; // Should be same as commentData.userId, but using req.user is safer

    const fmtName = (u: {
      name?: string | null;
      lastname?: string | null;
      nickname?: string | null;
    }) => {
      const base = [u.name, u.lastname].filter(Boolean).join(" ").trim();
      return u.nickname ? `${base} (${u.nickname})` : base || (u.name ?? "");
    };

    const actorDisp = fmtName(commenter);
    const subj = memo.subject ?? String(memoId);

    // Who to notify?
    // 1. Mentioned Users
    // 2. Memo Owner
    const mentionRecipients = new Set<number>(tags.map((t) => t.userId));
    mentionRecipients.delete(actorId);

    const ownerId = memo.userId;
    const others = new Set<number>();
    if (ownerId && ownerId !== actorId && !mentionRecipients.has(ownerId)) {
      others.add(ownerId);
    }

    const mentionedUsersList = await prisma.user.findMany({
      where: { id: { in: Array.from(mentionRecipients) } },
      select: { name: true, lastname: true, nickname: true },
    });
    const mentionedNames = mentionedUsersList.map((u) => fmtName(u));

    await prisma.comment.delete({ where: { id: commentId } });

    // Send In-app Notifications
    const buildNoti = (uid: number, message: string) => ({
      memoId,
      userId: uid,
      actorId,
      notificationTypeId: 2, // Reusing 2 for comment-related
      message,
    });

    const notis: any[] = [];

    // Use filterUsersForEmail to respect user notification preferences
    const mentionUsersArr = Array.from(mentionRecipients);
    const othersArr = Array.from(others);

    // Filter mentions
    const taggedUsers = await filterUsersForEmail(
      mentionUsersArr,
      "removed-mention",
    );
    const notifyMentions = new Set(taggedUsers);

    // Filter others
    const notifyOthersFilter = await filterUsersForEmail(
      othersArr,
      "removed-mention", // Notify owner also requires removed-mention or a new type. We use the same here.
    );
    const notifyOthers = new Set(notifyOthersFilter);

    for (const uid of mentionRecipients) {
      if (notifyMentions.has(uid)) {
        notis.push(
          buildNoti(
            uid,
            `${actorDisp} removed a mention of you in memo "${subj}".`,
          ),
        );
      }
    }
    for (const uid of others) {
      if (notifyOthers.has(uid)) {
        notis.push(
          buildNoti(
            uid,
            `${actorDisp} removed a comment mentioning ${mentionedNames.join(", ")} in "${subj}".`,
          ),
        );
      }
    }
    if (notis.length) await prisma.notification.createMany({ data: notis });

    // Send Emails
    const snippetText = commentData.comment
      ? commentData.comment.slice(0, 120)
      : "[attachment]";
    const memoNumber = memo.memonumber ?? String(memoId);

    const mentionList = [...mentionRecipients];
    if (mentionList.length) {
      await sendDeleteCommentEmailsAsync({
        receiverIds: mentionList,
        memoSubject: subj,
        memoNumber: memoNumber,
        memoId,
        commenter: actorDisp,
        snippet: snippetText,
        isMention: true,
        mentionedNames,
      });
    }
    if (others.size) {
      await sendDeleteCommentEmailsAsync({
        receiverIds: Array.from(others),
        memoSubject: subj,
        memoNumber: memoNumber,
        memoId,
        commenter: actorDisp,
        snippet: snippetText,
        isMention: false,
        mentionedNames,
      });
    }

    res.sendStatus(204);
    return;
  } catch (err) {
    console.error("❌ deleteComment failed", err);
    res.status(500).json({ error: "Failed to delete comment" });
    return;
  }
};

/* =========================================================================
   Send comment-notification e-mails (with login token)
   ========================================================================= */
export async function sendCommentEmailsAsync({
  receiverIds,
  memoSubject,
  memoNumber,
  memoId,
  commenter,
  snippet,
  isMention,
  mentionedNames,
}: {
  receiverIds: number[];
  memoSubject: string;
  memoNumber: string | number;
  memoId: number;
  commenter: string;
  snippet: string;
  isMention?: boolean;
  mentionedNames?: string[];
}) {
  try {
    // ✅ Double-guard: ข้ามการส่งเมลถ้า memo อยู่สถานะเงียบ (Draft/Recall)
    const latestPivot = await prisma.memoStatusPivot.findFirst({
      where: { memoId },
      orderBy: { id: "desc" },
      include: { status: { select: { id: true, name: true } } },
    });

    const SILENT_STATUS_IDS = new Set([1, 6]); // 1=Draft, 6=Recall
    const SILENT_STATUS_NAMES = new Set(["draft", "recalled"]);

    const stId = latestPivot?.status?.id ?? null;
    const stName = (latestPivot?.status?.name ?? "").toLowerCase();

    if (
      stId === null ||
      SILENT_STATUS_IDS.has(stId) ||
      SILENT_STATUS_NAMES.has(stName)
    ) {
      return;
    }

    // ไม่มีผู้รับ -> ไม่ต้องส่ง
    if (!receiverIds?.length) {
      return;
    }

    // Use different preference types based on mention status
    let notificationSlug = "new-comment";
    if (isMention) {
      notificationSlug = "tagged-in-comment";
    } else if (mentionedNames && mentionedNames.length > 0) {
      notificationSlug = "others-mentioned";
    }

    const filteredReceiverIds = await filterUsersForEmail(
      receiverIds,
      notificationSlug,
    );

    if (!filteredReceiverIds.length) {
      console.log(`No users want email notifications for ${notificationSlug}`);
      return;
    }

    const users = await prisma.user.findMany({
      where: { id: { in: filteredReceiverIds } },
      select: { id: true, name: true, email: true },
    });

    const sendTo = users.filter((u) => !!u.email);
    if (!sendTo.length) {
      return;
    }

    const subjectLine = isMention
      ? `You were mentioned on memo ${memoNumber}: ${memoSubject}`
      : mentionedNames && mentionedNames.length > 0
        ? `New comment (with mention) on memo ${memoNumber}: ${memoSubject}`
        : `New comment on memo ${memoNumber}: ${memoSubject}`;

    await Promise.allSettled(
      sendTo.map(async (u) => {
        // ───── สร้าง one-time login link ─────
        const token = await makeEmailToken(u.id, memoId);
        const viewLink = `${FRONTEND_URL}/memo/${memoId}`;

        return sendEmail(
          [u.email!],
          subjectLine, // << ใช้หัวข้อที่เปลี่ยนตามโหมด
          buildCommentPlain(
            u.name,
            commenter,
            snippet,
            memoNumber,
            viewLink,
            isMention,
            mentionedNames,
          ), // << ส่ง isMention และ names
          buildCommentHtml(
            u.name,
            commenter,
            snippet,
            memoSubject,
            memoNumber,
            viewLink,
            isMention,
            mentionedNames,
          ),
          [],
        );
      }),
    );
  } catch (err) {
    console.error("comment-mail error:", err);
  }
}

/* =========================================================================
   Plain-text template (new comment)
   ========================================================================= */
function buildCommentPlain(
  receiver: string,
  commenter: string,
  snippet: string,
  ref: string | number,
  viewLink: string,
  isReceiverMentioned = false,
  mentionedNames?: string[],
) {
  let lead = `${commenter} left a new comment:`;
  if (isReceiverMentioned) {
    if (mentionedNames && mentionedNames.length > 0) {
      lead = `${commenter} mentioned ${mentionedNames.join(", ")}:`;
    } else {
      lead = `${commenter} mentioned you:`;
    }
  } else if (mentionedNames && mentionedNames.length > 0) {
    lead = `${commenter} mentioned ${mentionedNames.join(", ")} in a comment:`;
  }

  return `Hello ${receiver},

${lead}
"${snippet}"

View details: ${viewLink}
Memo No.: ${ref}`;
}

/* =========================================================================
   HTML template (new comment)
   ========================================================================= */
function buildCommentHtml(
  receiver: string,
  commenter: string,
  snippet: string,
  subject: string,
  ref: string | number,
  viewLink: string,
  isReceiverMentioned = false,
  mentionedNames?: string[],
) {
  let leadHtml = `<strong>${commenter}</strong> left a new comment on memo <em>"${subject}"</em>`;
  if (isReceiverMentioned) {
    if (mentionedNames && mentionedNames.length > 0) {
      leadHtml = `<strong>${commenter}</strong> mentioned <b>${mentionedNames.join(", ")}</b> on memo <em>"${subject}"</em>`;
    } else {
      leadHtml = `<strong>${commenter}</strong> mentioned you on memo <em>"${subject}"</em>`;
    }
  } else if (mentionedNames && mentionedNames.length > 0) {
    leadHtml = `<strong>${commenter}</strong> mentioned <b>${mentionedNames.join(", ")}</b> in a comment on memo <em>"${subject}"</em>`;
  }

  return `
  <html>
    <body style="font-family:'Segoe UI',Arial,sans-serif;background:#f7f9fc;margin:0;padding:0">
      <div style="max-width:640px;margin:20px auto;background:#fff;border-radius:8px;overflow:hidden">
        <div style="background:#edecec; padding:25px;text-align:center">
          <h2 style="margin:0;color:#183e33">HyLife e-Approval</h2>
        </div>
        <div style="padding:30px">
          <p>Hello <strong>${receiver}</strong>,</p>
          <p>${leadHtml}</p>
          <blockquote style="margin:15px 0;padding-left:15px;border-left:3px solid #183e33;color:#555">
            ${snippet}
          </blockquote>
          <p style="text-align:center;margin:30px 0">
            <a href="${viewLink}"
               style="background:#183e33;color:#fff;padding:12px 28px;border-radius:5px;text-decoration:none">
              View Memo
            </a>
          </p>
          <p style="font-size:12px;color:#888">Memo No.: ${ref}</p>
        </div>
        <div style="background:#fafafa;text-align:center;font-size:12px;color:#777;padding:15px">
          © ${new Date().getFullYear()} HYLIFE GROUP
        </div>
      </div>
    </body>
  </html>`;
}

/* =========================================================================
   Send deleted-comment/mention e-mails
   ========================================================================= */
export async function sendDeleteCommentEmailsAsync({
  receiverIds,
  memoSubject,
  memoNumber,
  memoId,
  commenter,
  snippet,
  isMention,
  mentionedNames,
}: {
  receiverIds: number[];
  memoSubject: string;
  memoNumber: string | number;
  memoId: number;
  commenter: string;
  snippet: string;
  isMention?: boolean;
  mentionedNames?: string[];
}) {
  try {
    const latestPivot = await prisma.memoStatusPivot.findFirst({
      where: { memoId },
      orderBy: { id: "desc" },
      include: { status: { select: { id: true, name: true } } },
    });

    const SILENT_STATUS_IDS = new Set([1, 6]);
    const SILENT_STATUS_NAMES = new Set(["draft", "recalled"]);
    const stId = latestPivot?.status?.id ?? null;
    const stName = (latestPivot?.status?.name ?? "").toLowerCase();

    if (
      stId === null ||
      SILENT_STATUS_IDS.has(stId) ||
      SILENT_STATUS_NAMES.has(stName)
    ) {
      return;
    }

    if (!receiverIds?.length) return;

    // Since only comments with mentions can be deleted, we use the removed-mention pref
    const notificationSlug = "removed-mention";
    const filteredReceiverIds = await filterUsersForEmail(
      receiverIds,
      notificationSlug,
    );

    if (!filteredReceiverIds.length) return;

    const users = await prisma.user.findMany({
      where: { id: { in: filteredReceiverIds } },
      select: { id: true, name: true, email: true },
    });

    const sendTo = users.filter((u) => !!u.email);
    if (!sendTo.length) return;

    const subjectLine = isMention
      ? `A mention of you was deleted on memo ${memoNumber}: ${memoSubject}`
      : `A comment with a mention was deleted on memo ${memoNumber}: ${memoSubject}`;

    await Promise.allSettled(
      sendTo.map(async (u) => {
        const viewLink = `${FRONTEND_URL}/memo/${memoId}`;
        return sendEmail(
          [u.email!],
          subjectLine,
          buildDeleteCommentPlain(
            u.name,
            commenter,
            snippet,
            memoNumber,
            viewLink,
            isMention,
            mentionedNames,
          ),
          buildDeleteCommentHtml(
            u.name,
            commenter,
            snippet,
            memoSubject,
            memoNumber,
            viewLink,
            isMention,
            mentionedNames,
          ),
          [],
        );
      }),
    );
  } catch (err) {
    console.error("delete-comment-mail error:", err);
  }
}

/* =========================================================================
   Plain-text template (deleted comment)
   ========================================================================= */
function buildDeleteCommentPlain(
  receiver: string,
  commenter: string,
  snippet: string,
  ref: string | number,
  viewLink: string,
  isReceiverMentioned = false,
  mentionedNames?: string[],
) {
  let lead = `${commenter} deleted a comment.`;
  if (isReceiverMentioned) {
    lead = `${commenter} deleted a mention of you.`;
  } else if (mentionedNames && mentionedNames.length > 0) {
    lead = `${commenter} deleted a comment mentioning ${mentionedNames.join(", ")}.`;
  }

  return `Hello ${receiver},

${lead}

Previous message:
"${snippet}"

View details: ${viewLink}
Memo No.: ${ref}`;
}

/* =========================================================================
   HTML template (deleted comment)
   ========================================================================= */
function buildDeleteCommentHtml(
  receiver: string,
  commenter: string,
  snippet: string,
  subject: string,
  ref: string | number,
  viewLink: string,
  isReceiverMentioned = false,
  mentionedNames?: string[],
) {
  let leadHtml = `<strong>${commenter}</strong> removed a comment on memo <em>"${subject}"</em>`;
  if (isReceiverMentioned) {
    leadHtml = `<strong>${commenter}</strong> removed a mention of you on memo <em>"${subject}"</em>`;
  } else if (mentionedNames && mentionedNames.length > 0) {
    leadHtml = `<strong>${commenter}</strong> removed a comment mentioning <b>${mentionedNames.join(", ")}</b> on memo <em>"${subject}"</em>`;
  }

  return `
  <html>
    <body style="font-family:'Segoe UI',Arial,sans-serif;background:#f7f9fc;margin:0;padding:0">
      <div style="max-width:640px;margin:20px auto;background:#fff;border-radius:8px;overflow:hidden">
        <div style="background:#edecec; padding:25px;text-align:center">
          <h2 style="margin:0;color:#183e33">HyLife e-Approval</h2>
        </div>
        <div style="padding:30px">
          <p>Hello <strong>${receiver}</strong>,</p>
          <p>${leadHtml}</p>
          <p>The deleted message was:</p>
          <blockquote style="margin:15px 0;padding-left:15px;border-left:3px solid #ccc;color:#888;font-style:italic">
            <del>${snippet}</del>
          </blockquote>
          <p style="text-align:center;margin:30px 0">
            <a href="${viewLink}"
               style="background:#183e33;color:#fff;padding:12px 28px;border-radius:5px;text-decoration:none">
              View Memo
            </a>
          </p>
          <p style="font-size:12px;color:#888">Memo No.: ${ref}</p>
        </div>
        <div style="background:#fafafa;text-align:center;font-size:12px;color:#777;padding:15px">
          © ${new Date().getFullYear()} HYLIFE GROUP
        </div>
      </div>
    </body>
  </html>`;
}
