// src/pages/EditMemo.tsx
import React, { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import axios from "axios";
import MemoForm from "./MemoForm";

const EditMemo: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const memoId = Number(id);
  const navigate = useNavigate();
  const [me, setMe] = useState<{ id: number } | null>(null);

  // โหลดข้อมูล user ปัจจุบัน
  useEffect(() => {
    axios
      .get("/api/me", { withCredentials: true })
      .then((res) => setMe(res.data))
      .catch(() => setMe(null));
  }, []);

  const handleSaved = () => {
    navigate(`/memos/${memoId}`);
  };

  const handleCancel = async () => {
    if (!me) {
      navigate(`/memos/${memoId}`);
      return;
    }

    try {
      // 1) ดึง mainFileId ของ memo (ถ้ามี)
      const { data: memoData } = await axios.get(`/api/memos/${memoId}`, {
        withCredentials: true,
      });
      const fileId =
        memoData.mainFiles && memoData.mainFiles.length > 0
          ? memoData.mainFiles[0].id
          : null;

      // 2) เรียก API เปลี่ยนกลับเป็น Draft (statusId = 1)
      await axios.post(
        `/api/memos/${memoId}/status`,
        {
          memoId,
          userId: me.id,
          statusId: 1, // 1 = Draft
          fileId,
        },
        { withCredentials: true }
      );
    } catch (err) {
      console.error("Revert to Draft failed:", err);
    } finally {
      // 3) ไม่ว่าจะสำเร็จหรือไม่ ให้กลับไปหน้า Detail เสียก่อน
      navigate(`/memos/${memoId}`);
    }
  };

  if (me === null) return <div className="p-10">Loading user…</div>;

  return (
    <div className="w-full">
      {/* หัวเรื่อง + ปุ่ม Cancel */}
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Edit Memo #{memoId}</h1>
        <button
          onClick={handleCancel}
          className="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded"
        >
          Cancel
        </button>
      </div>

      <MemoForm
        mode="edit"
        memoId={memoId}
        onSaved={handleSaved}
        onCancel={handleCancel}
      />
    </div>
  );
};

export default EditMemo;
