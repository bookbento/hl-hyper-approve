// component/RequireAuth.tsx
import { Outlet } from "react-router-dom";

export default function RequireAuth() {
  // TEMPORARY BYPASS AUTH
  return <Outlet />;
}
