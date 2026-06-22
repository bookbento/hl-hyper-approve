import { useNavigate } from "react-router-dom";
import { useEffect } from "react";
import MemoForm from "./MemoForm";


export default function CreateMemo() {
  const nav = useNavigate();
  
  // Set page title
  useEffect(() => {
    document.title = "HyLife e-Approval | Create Memo";
    
    // Cleanup: restore default title when component unmounts
    return () => {
      document.title = "HyLife e-Approval";
    };
  }, []);
  
  return (
    <div className="w-full">
    <MemoForm
      mode="create"
      onSaved={newId => {
        if (newId) nav(`/memos/${newId}`);
      }}
    />
    </div>
  );
}