// App.tsx
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Outlet,
} from "react-router-dom";
import Navigation from "./components/Navigation";
import Dashboard from "./page/Dashboard/dashboard";
import CreateMemo from "./page/CreateMemo/CreateMemo";
import ShowUsers from "./page/CreateUser/ShowUser";
import CreateDepartment from "./page/CreateDepartment/CreateDepartment";
import ProfilePage from "./page/ProfilePage/ProfilePage";
import MemoViewer from "./page/MemoViewer/MemoViewer";
import EditMemo from "./page/CreateMemo/EditMemo";
import { Toaster } from "react-hot-toast";
import "./App.css";
import ShowAppover from "./page/ShowAppover/Showappover";
import MemoTypeManager from "./page/MemoTypeManager/MemoTypeManager";
import MemoTypeDisplay from "./page/MemoTypeDisplay";
import MemoTypeDetail from "./page/MemoTypeDetail/MemoTypeDetail";
import CreateBusinessUnit from "./page/CreatebusinessUnit/CreatebusinessUnit";
import "./i18n";  
import Login from "./page/Login/Login";
import FirstTimePasswordChange from "./page/FirstTimePasswordChange/FirstTimePasswordChange";
import ComplexIcon from "./components/Mran";
import LoadingScreen from "./components/Mhan";
import RequireAuth from "./components/RequireAuth";
import RequireAdmin from "./components/RequireAdmin";
import CcGroups from "./page/CcGroups/CcGroups";
import LoaManagementPage from "./page/LOAManagementPage/LOAManagementPage";
function PrivateLayout() {
  return (
    <div className="flex flex-col h-screen">
      <Toaster position="top-right" />

      {/* เอา Navigation ขึ้นมาบนสุด */}
      <Navigation />

      {/* เอา id ให้ main สำหรับฟัง scroll */}
      <main id="scroll-container" className="pt-16 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* public */}
        <Route path="/login" element={<Login />} />
        <Route path="/change-password" element={<FirstTimePasswordChange />} />

        {/* private (auth required) */}
        <Route element={<RequireAuth />}>
          <Route element={<PrivateLayout />}>
            <Route index element={<Dashboard />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="profile" element={<ProfilePage />} />
            <Route path="memos">
              <Route path="new" element={<CreateMemo />} />
              <Route path=":id/edit" element={<EditMemo />} />
            </Route>
            <Route path="memo/:id" element={<MemoViewer />} />
            
            {/* Admin-only routes */}
            <Route element={<RequireAdmin />}>
              <Route path="user" element={<ShowUsers />} />
              <Route path="department" element={<CreateDepartment />} />
              <Route path="business-units" element={<CreateBusinessUnit />} />
              
            </Route>
            
            <Route path="memotype" element={<MemoTypeDisplay />} />
            <Route path="memotype/:id" element={<MemoTypeDetail />} />
            <Route path="memotype-manager" element={<MemoTypeManager />} />
            <Route path="appover" element={<ShowAppover />} />
            <Route path="mran" element={<ComplexIcon />} />
            <Route path="mhan" element={<LoadingScreen />} />
            <Route path="cc-groups" element={<CcGroups />} />
            <Route path="approver-lines" element={<LoaManagementPage />} />
            {/* 404 ในเขต private */}
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Route>
        </Route>

        {/* 404 นอกเขต (เผื่อพิมพ์ path มั่ว ๆ) */}
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
