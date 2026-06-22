// Core TypeScript interfaces for MemoTypeDisplay feature

export interface MemoType {
  id: number;
  name: string;
  description: string;
  abbreviation: string;
  isActive: boolean;
  createdAt: string;

  // ===== Team (optional) =====
  teamId?: number | null;
  team: {
    id: number;
    name: string;
    businessUnit?: { id: number; name: string };
    department?: { id: number; name: string };
  } | null;

  // ===== Business Unit (optional) =====
  businessUnitId?: number | null;
  businessUnit?: { id: number; name: string } | null;

  // ===== Department (NEW - needed for Across BU) =====
  departmentId?: number | null;               // 🔥 เพิ่ม
  department?: { id: number; name: string } | null; // 🔥 เพิ่ม

  // ===== Approval Line =====
  approvalLineId?: number | null;
  approvalLine?: { id: number; name: string } | null;
  approvalLines?: ApprovalLine[];
  approvalLevels?: ApprovalLevelFromAPI[];

  // defaultTypeFileId?: number | null; // ⚠️ Commented out - field removed from schema
  typeFiles?: {
    id: number;
    fileName: string;
    filePath: string;
    size: number;
    orderNo: number;
  }[];

  // ===== Visibility flags =====
  forEveryone?: boolean;
  forAllDepartmentUnderSelectedBu?: boolean;
  forEveryDepartmentAcrossBU?: boolean;
}

export interface ApprovalLevelFromAPI {
  level: number;
  users: {
    id: number;
    name: string;
    lastname?: string | null;
    nickname?: string | null;
    isSigReq?: boolean;
    slotType?: string;
    roleDescription?: string;
    approvalRequirement?: "ALL" | "ANY";
  }[];
}

export interface ApprovalLine {
  id: number;
  name: string;
  steps: ApprovalStep[];
}

export interface ApprovalStep {
  id: number;
  stepNumber: number;
  approverType: string;
  approver?: User;
}

export interface User {
  id: number;
  name: string;
  email: string;
  role?: string;
}

export interface TableState {
  searchTerm: string;
  sortKey: keyof MemoType;         // ใช้ได้เลย: มี 'businessUnit' และ 'department' แล้ว
  sortDirection: 'asc' | 'desc';
  currentPage: number;
  pageSize: number;
}

export interface ModalState {
  isOpen: boolean;
  selectedMemoType: MemoType | null;
  mode: 'view' | 'edit' | 'delete';
}

export interface BusinessUnit {
  id: number;
  name: string;
}

export interface Team {
  id: number;
  name: string;
  department?: { id: number; name: string };
}

export interface MeRes {
  id: number;
  role?: string;
  roles?: string[];
  teamId?: number;
  team?: { id: number; name: string };
}
