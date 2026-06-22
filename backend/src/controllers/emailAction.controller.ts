// src/controllers/emailAction.controller.ts
import { RequestHandler } from "express";
import { verifyEmailToken } from "../lib/token";
import {
  evaluateAndUpdateMemoStatus,
  notifyStatusUpdate,
} from "./memoStatus.controller";
import { prisma } from "../../prisma/client";
import path from "path";
import fs from "fs/promises"; // สำหรับ readFile
import * as fsSync from "fs";

const RAW_FRONT_URL =
  process.env.FRONTEND_URL ??
  process.env.FRONT_BASE_URL ??
  "http://172.16.8.215:5173";

const FRONT_URL = RAW_FRONT_URL.replace(/\/+$/, ""); // ตัด / ท้ายกันซ้อน //
const makeViewLink = (id: number) => `${FRONT_URL}/memos/${id}`;

const renderWithLink = (html: string, memoId: number, condition?: string | null, reason?: string | null) => {
  let result = html
    .replace(/__MEMO_ID__/g, String(memoId))
    .replace(/__VIEW_LINK__/g, makeViewLink(memoId));
  
  // Replace condition section for approved emails
  if (condition) {
    const conditionHtml = `
    <div style="margin: 1rem auto; padding: 1rem; max-width: 600px; background-color: rgba(255, 255, 255, 0.8); border-radius: 8px; text-align: left;">
      <p style="margin: 0 0 0.5rem 0; font-weight: bold; color: #0c7f36;">Approval Condition:</p>
      <p style="margin: 0; color: #333; white-space: pre-wrap;">${condition}</p>
    </div>`;
    result = result.replace(/__CONDITION_SECTION__/g, conditionHtml);
  } else {
    result = result.replace(/__CONDITION_SECTION__/g, '');
  }
  
  // Replace reason section for rejected/terminated emails
  if (reason) {
    const reasonHtml = `
    <div style="margin: 1rem auto; padding: 1rem; max-width: 600px; background-color: rgba(255, 255, 255, 0.8); border-radius: 8px; text-align: left;">
      <p style="margin: 0 0 0.5rem 0; font-weight: bold; color: #bf1e2e;">Reason:</p>
      <p style="margin: 0; color: #333; white-space: pre-wrap;">${reason}</p>
    </div>`;
    result = result.replace(/__REASON_SECTION__/g, reasonHtml);
  } else {
    result = result.replace(/__REASON_SECTION__/g, '');
  }
  
  return result;
};
function resolveEmailTemplatePath(
  statusCode: "approved" | "rejected" | "terminated"
) {
  const fileName = `${statusCode}.html`;
  const candidates = [
    // เวลา run จากไฟล์คอมไพล์ (dist)
    path.resolve(__dirname, "../../views/email-actions", fileName),
    path.resolve(process.cwd(), "dist", "views", "email-actions", fileName),
    // เวลา run แบบ dev/ts-node
    path.resolve(process.cwd(), "src", "views", "email-actions", fileName),
    path.resolve(process.cwd(), "views", "email-actions", fileName),
  ];

  for (const p of candidates) {
    if (fsSync.existsSync(p)) {
      console.log("✅ Using email template:", p);
      return p;
    }
  }
  throw new Error(
    `[email-template] Not found for "${statusCode}". Tried:\n` +
      candidates.join("\n")
  );
}


// types.ts (หรือไว้บนสุดของ controller ก็ได้)
type Code = "approved" | "rejected" | "terminated";

type ViewConfig = {
  title: string;
  verb: string;
  img: string;
  bg: string;
  accent: string;
};

// ── แยก CONFIG ออกเป็นก้อน ๆ ──────────────────────────────────────────────
// ใส่รูปไว้ใน public/img หรือโฟลเดอร์ static ที่เสิร์ฟได้
const IMAGES: Record<Code, string> = {
  approved:   "/img/mhan_approved.png",
  rejected:   "/img/mhan_rejected.png",
  terminated: "/img/mhan_link_terminated.png",
};

// ถ้าอยากรองรับธีม/แบรนด์ในอนาคต แยกสีออกมาแบบนี้
const COLORS: Record<Code, { bg: string; accent: string }> = {
  approved:   { bg: "#aef5b7", accent: "#16a34a" }, // เขียว
  rejected:   { bg: "#f0c0c0", accent: "#c42b2b" }, // แดง
  terminated: { bg: "#fae1c3", accent: "#b45309" }, // ส้ม/น้ำตาล
};

// ข้อความ (ถ้าจะทำ i18n ต่อ สามารถโยกไปที่ไฟล์แปลได้)
const MESSAGES: Record<Code, { title: string; verb: string }> = {
  approved:   { title: "This document has been already approved",   verb: "approved" },
  rejected:   { title: "This document has been already Rejected",   verb: "rejected" },
  terminated: { title: "This document has been already Terminated", verb: "terminated" },
};

// รวมเป็น view config ที่ส่วนเรนเดอร์จะใช้เพียงตัวเดียว
function getUsedView(code: Code): ViewConfig {
  return {
    title:  MESSAGES[code].title,
    verb:   MESSAGES[code].verb,
    img:    IMAGES[code],
    bg:     COLORS[code].bg,
    accent: COLORS[code].accent,
  };
}


export const handleEmailAction: RequestHandler = async (req, res) => {
  /* ------------------------------------------------------------------ */
  /* 1) รับ token + action จาก query‐string                              */
  /* ------------------------------------------------------------------ */
  const token = req.query.token as string;
  const action = (req.query.action as string)?.toLowerCase(); // "approve" | "reject" | "terminate"
  if (!token || !["approve", "reject", "terminate"].includes(action)) {
    res.status(400).send("ลิงก์ไม่ถูกต้องหรือหมดอายุแล้ว");
    return;
  }

  /* ------------------------------------------------------------------ */
  /* 2) ถอดรหัส token → { memoId, loaActionId }                         */
  /* ------------------------------------------------------------------ */
  const payload = verifyEmailToken(token); // ไม่มี field action แล้ว
  if (!payload) {
    res.status(400).send();
    return;
  }
  const { memoId, loaActionId: actionId } = payload;
  
  /* ------------------------------------------------------------------ */
  /* 2.5) ถ้าเป็น reject → redirect ไปที่ frontend แทน                  */
  /* ------------------------------------------------------------------ */
  if (action === "reject") {
    const redirectUrl = `${FRONT_URL}/memo/${memoId}?action=reject&token=${token}`;
    res.redirect(redirectUrl);
    return;
  }
  
  let statusCode: "approved" | "rejected" | "terminated";
  if (action === "approve") statusCode = "approved";
  else if (action === "reject") statusCode = "rejected";
  else statusCode = "terminated";

  /* ------------------------------------------------------------------ */
  /* 3) ตรวจสอบว่า action แถวนี้ยัง waiting และ token ตรงกัน             */
  /* ------------------------------------------------------------------ */
  const waiting = await prisma.approvalActionStatus.findUnique({
    where: { code: "waiting" },
    select: { id: true },
  });
  if (!waiting) {
    res.status(500).send("ระบบไม่พบสถานะ waiting");
    return;
  }

  const actionRow = await prisma.memoApproverAction.findUnique({
    where: { id: actionId },
    select: { emailToken: true, statusId: true, loaUserId: true },
  });

  if (!actionRow) {
    res.status(404).send("ไม่พบข้อมูลการอนุมัติ");
    return;
  }

  // ❷ เมื่อมาถึงตรงนี้ TypeScript รู้แล้วว่า actionRow ≠ null
  const pivot = await prisma.lineOfApprovalUserPivotForUse.findUnique({
    where: { id: actionRow.loaUserId },
    select: { 
      userId: true, 
      user: { 
        select: { 
          name: true, 
          lastname: true, 
          nickname: true,
          defaultSignatureText: true 
        } 
      } 
    },
  });

  if (!pivot) {
    res.status(404).send("Approver pivot not found");
    return;
  }

  const actorId = pivot.userId;
  const actorName = pivot.user?.name || "Unknown User";
  
  // สร้าง signatureText: ใช้ defaultSignatureText ก่อน ถ้าไม่มีให้ใช้ชื่อจริง
  const makeDisplayName = (u: { name?: string | null; lastname?: string | null; nickname?: string | null }) => {
    const base = [u?.name, u?.lastname].filter(Boolean).join(" ").trim();
    return u?.nickname ? `${base} (${u.nickname})` : base || (u?.name ?? "");
  };
  const signatureTextForEmail = pivot.user?.defaultSignatureText?.trim() || makeDisplayName(pivot.user || {});
  if (!actionRow) {
    res.status(404).send("ไม่พบข้อมูลการอนุมัติ");
    return;
  }

if (actionRow.statusId !== waiting.id) {
  // ดูสถานะจริงที่ถูกใช้ไปแล้ว (approved | rejected | terminated)
  const used = await prisma.approvalActionStatus.findUnique({
    where: { id: actionRow.statusId },
    select: { code: true }, // "approved" | "rejected" | "terminated"
  });

  // ดึงข้อมูล condition/reason
  const actionData = await prisma.memoApproverAction.findUnique({
    where: { id: actionId },
    select: { 
      approveWithCondition: true,
      rejectReason: true,
      terminationReason: true
    }
  });

  const key = (used?.code as Code) ?? "approved";
  const v   = getUsedView(key);

  // สร้าง section สำหรับแสดง condition/reason
  let extraSection = '';
  if (key === 'approved' && actionData?.approveWithCondition) {
    extraSection = `
      <div style="margin: 1rem auto; padding: 1rem; max-width: 600px; background-color: rgba(255, 255, 255, 0.8); border-radius: 8px; text-align: left;">
        <p style="margin: 0 0 0.5rem 0; font-weight: bold; color: ${v.accent};">Approval Condition:</p>
        <p style="margin: 0; color: #333; white-space: pre-wrap;">${actionData.approveWithCondition}</p>
      </div>`;
  } else if (key === 'rejected' && actionData?.rejectReason) {
    extraSection = `
      <div style="margin: 1rem auto; padding: 1rem; max-width: 600px; background-color: rgba(255, 255, 255, 0.8); border-radius: 8px; text-align: left;">
        <p style="margin: 0 0 0.5rem 0; font-weight: bold; color: ${v.accent};">Reject Reason:</p>
        <p style="margin: 0; color: #333; white-space: pre-wrap;">${actionData.rejectReason}</p>
      </div>`;
  } else if (key === 'terminated' && actionData?.terminationReason) {
    extraSection = `
      <div style="margin: 1rem auto; padding: 1rem; max-width: 600px; background-color: rgba(255, 255, 255, 0.8); border-radius: 8px; text-align: left;">
        <p style="margin: 0 0 0.5rem 0; font-weight: bold; color: ${v.accent};">Termination Reason:</p>
        <p style="margin: 0; color: #333; white-space: pre-wrap;">${actionData.terminationReason}</p>
      </div>`;
  }

  res.status(400).send(
    renderWithLink(
      `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${v.title}</title>
    <style>
      body { margin:0; padding:0 1rem; display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:100vh; font-family:sans-serif; background:${v.bg}; text-align:center; }
      img { width:100%; max-width:200px; height:auto; margin-bottom:1rem; }
      h1 { font-size:1.5rem; color:${v.accent}; margin-bottom:0.5rem; }
      p  { font-size:1rem; color:#333; }
      a  { display:inline-block; margin-top:1rem; padding:0.5rem 1rem; background:${v.accent}; color:#fff; text-decoration:none; border-radius:4px; font-weight:bold; }
      @media (max-width:480px){ h1{font-size:1.2rem} p{font-size:.9rem} a{padding:.4rem .8rem; font-size:.9rem} }
    </style>
  </head>
  <body>

    <h1>${v.title}</h1>
    <p>You have already ${v.verb} this Document.</p>
    ${extraSection}
    <a href="__VIEW_LINK__">Return to HyLife e-Approval</a>
  </body>
</html>
`,
      memoId
    )
  );
  return;
}

  if (actionRow.emailToken !== token) {
    res.status(400).send(
      renderWithLink(
        `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Link Canceled or Used</title>
        <style>
          body {
            margin: 0;
            padding: 0 1rem;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            font-family: sans-serif;
            background-color: #c8c9c5;
            text-align: center;
          }
          img {
            width: 80%;
            max-width: 250px;
            height: auto;
            margin-bottom: 1rem;
          }
          h1 {
            font-size: 1.5rem;
            color: #000000;
            margin-bottom: 0.5rem;
          }
          p {
            font-size: 1rem;
            color: #333;
          }
          a {
            display: inline-block;
            margin-top: 1rem;
            padding: 0.5rem 1rem;
            background-color: #201e21;
            color: #fff;
            text-decoration: none;
            border-radius: 4px;
            font-weight: bold;
          }
          @media (max-width: 480px) {
            h1 { font-size: 1.2rem; }
            p  { font-size: 0.9rem; }
            a  { padding: 0.4rem 0.8rem; font-size: 0.9rem; }
          }
        </style>
      </head>
      <body>

        <h1>This link has been canceled or already used</h1>
        <p>Please request a new approval email.</p>
        <a href="__VIEW_LINK__">Return to HyLife e-Approval</a>
      </body>
    </html>
  `,
        memoId
      )
    );
    return;
  }



  /* ------------------------------------------------------------------ */
  /* 3.5) ตรวจสอบว่า memo หมดอายุหรือยัง                                  */
  /* ------------------------------------------------------------------ */
  const memoForExpiry = await prisma.masterMemo.findUnique({
    where: { id: memoId },
    select: { expiresAt: true },
  });

  if (memoForExpiry?.expiresAt && new Date() > memoForExpiry.expiresAt) {
    const actionText =
      action === "approve"
        ? "approve"
        : action === "reject"
        ? "reject"
        : "terminate";
    res.status(400).send(
      renderWithLink(
        `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Document Expired</title>
        <style>
          body {
            margin: 0;
            padding: 0 1rem;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            font-family: sans-serif;
            background-color: #fdecfdff;
            text-align: center;
          }
          img {
            width: 100%;
            max-width: 300px;
            height: auto;
            margin-bottom: 1rem;
          }
          h1 {
            font-size: 1.5rem;
            color: #831562ff;
            margin-bottom: 0.5rem;
          }
          p {
            font-size: 1rem;
            color: #333;
          }
          a {
            display: inline-block;
            margin-top: 1rem;
            padding: 0.5rem 1rem;
            background-color: #da2cd4ff;
            color: #fff;
            text-decoration: none;
            border-radius: 4px;
            font-weight: bold;
          }
          @media (max-width: 480px) {
            h1 { font-size: 1.2rem; }
            p  { font-size: 0.9rem; }
            a  { padding: 0.4rem 0.8rem; font-size: 0.9rem; }
          }
        </style>
      </head>
      <body>

        <h1>This Document Has Expired</h1>
        <p>You cannot ${actionText} this document because it has already expired.</p>
        <a href="__VIEW_LINK__">Return to HyLife e-Approval</a>
      </body>
    </html>
  `,
        memoId
      )
    );
    return;
  }

  /* ------------------------------------------------------------------ */
  /* 4) ตรวจสอบว่ามี MemoStatus = Processing อยู่ (ยังไม่จบขั้นตอน)      */
  /* ------------------------------------------------------------------ */
  const owner = await prisma.masterMemo.findUnique({
    where: { id: memoId },
    select: { userId: true },
  });
  if (!owner) {
    res.status(404).send("ไม่พบเอกสารนี้");
    return;
  }
  const stillProcessing = await prisma.memoStatusPivot.findUnique({
    where: {
      memoId_userId_statusId: {
        memoId,
        userId: owner.userId,
        statusId: 5, // Processing
      },
    },
  });
  if (!stillProcessing) {
    const actionText =
      statusCode === "approved"
        ? "approve"
        : statusCode === "rejected"
        ? "reject"
        : "terminate";
    res.status(400).send(
      renderWithLink(
        `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Cannot ${actionText}</title>
        <style>
          body {
            margin: 0;
            padding: 0 1rem;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            font-family: sans-serif;
            background-color: #fff5f5;
            text-align: center;
          }
          img {
            width: 80%;
            max-width: 200px;
            height: auto;
            margin-bottom: 1rem;
          }
          h1 {
            font-size: 1.5rem;
            color: #c42b2b;
            margin-bottom: 0.5rem;
          }
          p {
            font-size: 1rem;
            color: #333;
          }
          a {
            display: inline-block;
            margin-top: 1rem;
            padding: 0.5rem 1rem;
            background-color: #c42b2b;
            color: #fff;
            text-decoration: none;
            border-radius: 4px;
            font-weight: bold;
          }
          @media (max-width: 480px) {
            h1 { font-size: 1.2rem; }
            p  { font-size: 0.9rem; }
            a  { padding: 0.4rem 0.8rem; font-size: 0.9rem; }
          }
        </style>
      </head>
      <body>

        <h1>Cannot ${actionText}</h1>
        <p>The document is not in the Processing stage.</p>
        <a href="__VIEW_LINK__">Return to HyLife e-Approval</a>
      </body>
    </html>
  `,
        memoId
      )
    );
    return;
  }

  /* ------------------------------------------------------------------ */
  /* 5) เปลี่ยนสถานะแถว ApproverAction → approved/rejected               */
  /* ------------------------------------------------------------------ */
  const newStatus = await prisma.approvalActionStatus.findUnique({
    where: { code: statusCode },
    select: { id: true },
  });
  if (!newStatus) {
    res.status(500).send("ไม่พบสถานะปัจจุบัน");
    return;
  }
// 5) เปลี่ยนสถานะแถว ApproverAction → approved/rejected/terminated (ทำแล้ว)
await prisma.memoApproverAction.update({
  where: { id: actionId },
  data: {
    statusId: newStatus.id,
    actedAt: new Date(),
    emailToken: null,
    signatureText: signatureTextForEmail, // ✅ ใช้ defaultSignatureText หรือ display name
  },
});

// ⬇️ เพิ่มบันทึกประวัติ “ใครกดอะไร” (แบบ event log)
if (actorId) {
  await prisma.memoHistory.create({
  data: {
    memoId,
    userId: actorId!,                     // ✅ คนที่กด (we'll wrap in if check)
    statusId: null,                       // หรือจะใส่ 5 = Processing ก็ได้ หากต้องการ
    action: statusCode === "approved"
      ? `${actorName} Approved the memo via email`
      : statusCode === "rejected"
      ? `${actorName} Rejected the memo via email`
      : `${actorName} Terminated the memo via email`,
    // actiontype: null  // (ยังไม่ใช้ enum ก็ปล่อยว่าง)
    timestamp: new Date(),
  },
  });
}




  /* 5) ถ้าเป็น TERMINATE ให้จัดการตรงนี้แล้ว return เลย ---------------- */
  if (statusCode === "terminated") {
    // 5.1 อัปเดตแถว approverAction เป็น terminated
    const terminatedSid = (await prisma.approvalActionStatus.findUnique({
      where: { code: "terminated" },
      select: { id: true },
    }))!.id;

    await prisma.memoApproverAction.update({
      where: { id: actionId },
      data: {
        statusId: terminatedSid,
        actedAt: new Date(),
        emailToken: null,
      },
    });

    // 5.2 สร้าง MemoStatus = 7 + history
    await prisma.$transaction([
      prisma.memoStatusPivot.create({
        data: { memoId, userId: owner.userId, statusId: 7 },
      }),
      // prisma.memoHistory.create({
      //   data: {
      //     memoId,
      //     userId: actorId, // 👈 จาก pivot ข้างบน
      //     statusId: 7,
      //     actiontype: "PUBLISH",
      //     action: "Terminated via email-link",
      //     timestamp: new Date(),
      //   },
      // }),
    ]);

        /* 5.4 ── โหลดและส่ง terminated.html ───────────────────────────── */
    const htmlPath = resolveEmailTemplatePath(statusCode);
    const html = await fs.readFile(htmlPath, "utf-8");

    res.send(renderWithLink(html, memoId));

    // 5.3 แจ้งเตือน
    if (actorId) {
      await notifyStatusUpdate(memoId, actorId, actorName, 7, null);
    }


    return;
  }

  /* 6) ประเมินสถานะรวม + broadcast → รันแบบ background ไม่ block response */
  evaluateAndUpdateMemoStatus(memoId, actionRow.loaUserId)
    .then(() => {
      console.log(
        "[emailAction] evaluateAndUpdateMemoStatus finished for memo",
        memoId
      );
    })
    .catch((err) => {
      console.error(
        "[emailAction] evaluateAndUpdateMemoStatus error for memo",
        memoId,
        err
      );
    });

  /* 7) แสดงผลลัพธ์ให้ผู้ใช้ (ไม่รอข้อ 6 แล้ว)                         */
  try {
    // ดึงข้อมูล condition/reason จาก action row
    const actionData = await prisma.memoApproverAction.findUnique({
      where: { id: actionId },
      select: { 
        approveWithCondition: true,
        rejectReason: true,
        terminationReason: true
      }
    });

    const htmlPath = resolveEmailTemplatePath(statusCode);
    const html = await fs.readFile(htmlPath, "utf-8");
    
    // ส่ง condition สำหรับ approved, reason สำหรับ rejected/terminated
    let condition: string | null = null;
    let reason: string | null = null;
    
    if (statusCode === 'approved') {
      condition = actionData?.approveWithCondition ?? null;
    } else if (statusCode === 'rejected') {
      reason = actionData?.rejectReason ?? null;
    } else if (statusCode === 'terminated') {
      reason = actionData?.terminationReason ?? null;
    }
    
    res.send(renderWithLink(html, memoId, condition, reason));
  } catch (err) {
    console.error("ไม่สามารถโหลดไฟล์ HTML:", err);
    if (!res.headersSent) {
      res.status(500).send("เกิดข้อผิดพลาดในการโหลดหน้าแสดงผล");
    }
  }
};

