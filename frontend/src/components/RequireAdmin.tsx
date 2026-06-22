// src/components/RequireAdmin.tsx
import { Outlet } from "react-router-dom";

export default function RequireAdmin() {
  // TEMPORARY BYPASS ADMIN
  return <Outlet />;
}
