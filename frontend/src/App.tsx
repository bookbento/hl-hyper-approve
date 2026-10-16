// App.tsx
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Outlet,
} from "react-router-dom";
import { lazy, Suspense } from "react";
import { Toaster } from "react-hot-toast";
import "./App.css";
import "./i18n";
import RequireAuth from "./components/RequireAuth";
import RequireAdmin from "./components/RequireAdmin";
import LatticeLoader from "./components/reactbits/LatticeLoader/LatticeLoader";

// Each page is its own chunk: opening the dashboard no longer downloads the
// memo editor, the PDF viewer, admin pages, etc. (was one 2.7 MB bundle).
// The navbar (bell, notification list, motion) is not needed on /login.
const Navigation = lazy(() => import("./components/Navigation"));
const Dashboard = lazy(() => import("./page/Dashboard/dashboard"));
const CreateMemo = lazy(() => import("./page/CreateMemo/CreateMemo"));
const ShowUsers = lazy(() => import("./page/CreateUser/ShowUser"));
const CreateDepartment = lazy(() => import("./page/CreateDepartment/CreateDepartment"));
const ProfilePage = lazy(() => import("./page/ProfilePage/ProfilePage"));
const MemoViewer = lazy(() => import("./page/MemoViewer/MemoViewer"));
const EditMemo = lazy(() => import("./page/CreateMemo/EditMemo"));
const ShowAppover = lazy(() => import("./page/ShowAppover/Showappover"));
const MemoTypeManager = lazy(() => import("./page/MemoTypeManager/MemoTypeManager"));
const MemoTypeDisplay = lazy(() => import("./page/MemoTypeDisplay"));
const MemoTypeDetail = lazy(() => import("./page/MemoTypeDetail/MemoTypeDetail"));
const CreateBusinessUnit = lazy(() => import("./page/CreatebusinessUnit/CreatebusinessUnit"));
const Login = lazy(() => import("./page/Login/Login"));
const FirstTimePasswordChange = lazy(
  () => import("./page/FirstTimePasswordChange/FirstTimePasswordChange")
);
const ComplexIcon = lazy(() => import("./components/Mran"));
const LoadingScreen = lazy(() => import("./components/Mhan"));
const CcGroups = lazy(() => import("./page/CcGroups/CcGroups"));
const LoaManagementPage = lazy(() => import("./page/LOAManagementPage/LOAManagementPage"));

function PageFallback() {
  return (
    <div className="flex h-full min-h-[50vh] items-center justify-center" aria-busy="true">
      {/* React Bits LatticeLoader while a page chunk downloads */}
      <LatticeLoader label="Loading" showTimer={false} color="#23805f" glow glowColor="#7ef0c2" />
    </div>
  );
}

function PrivateLayout() {
  return (
    <div className="flex flex-col h-screen">
      <Toaster position="top-right" />

      {/* เอา Navigation ขึ้นมาบนสุด */}
      <Suspense fallback={<div className="fixed inset-x-0 top-0 z-50 h-16 bg-[#183e33]/95" />}>
        <Navigation />
      </Suspense>

      {/* เอา id ให้ main สำหรับฟัง scroll */}
      <main id="scroll-container" className="pt-16 flex-1 overflow-y-auto">
        <Suspense fallback={<PageFallback />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* public */}
        <Route
          path="/login"
          element={
            <Suspense fallback={<PageFallback />}>
              <Login />
            </Suspense>
          }
        />
        <Route
          path="/change-password"
          element={
            <Suspense fallback={<PageFallback />}>
              <FirstTimePasswordChange />
            </Suspense>
          }
        />

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
