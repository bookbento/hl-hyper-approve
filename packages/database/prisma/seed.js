"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
async function main() {
    // 1) Seed Business Units
    await prisma.businessUnit.createMany({
        data: [
            { id: 27, name: 'DR. HYGIENE MEDICAL PRODUCTS CO., LTD', abbreviation: 'DRHG' },
            { id: 28, name: 'HA CONSTRUCTION CO., LTD', abbreviation: 'HACO' },
            { id: 29, name: 'HYFIRST CO., LTD', abbreviation: 'HFST' },
            { id: 30, name: 'HYLIFE ASSET CO., LTD', abbreviation: 'HLAS' },
            { id: 31, name: 'HYLIFE CONSTRUCTION CO., LTD', abbreviation: 'HCON' },
            { id: 32, name: 'HYLIFE DEVELOPMENTS CO., LTD', abbreviation: 'HDEV' },
            { id: 33, name: 'HYLIFE GLOBAL FOOD CO., LTD', abbreviation: 'HLGF' },
            { id: 35, name: 'HYLIFE IBC CO., LTD', abbreviation: 'HIBC' },
            { id: 37, name: 'HYLIFE PROPERTY SERVICE MANAGEMENT CO., LTD', abbreviation: 'HPSM' }
        ],
        skipDuplicates: true,
    });
    // 2) Seed Departments
    await prisma.department.createMany({
        data: [
            { id: 26, name: 'Executive Office', businessUnitId: null, abbreviation: 'EXO' },
            { id: 27, name: 'Corporate Communication', businessUnitId: null, abbreviation: 'CCC' },
            { id: 28, name: 'Finance & Accounting', businessUnitId: null, abbreviation: 'FAC' },
            { id: 29, name: 'HR & Admin', businessUnitId: null, abbreviation: 'HRA' },
            { id: 30, name: 'Software Development', businessUnitId: null, abbreviation: 'SDEV' },
            { id: 31, name: 'Land Management', businessUnitId: null, abbreviation: 'LND' },
            { id: 32, name: 'Procurement', businessUnitId: null, abbreviation: 'PRC' }
        ],
        skipDuplicates: true,
    });
    // 3) Seed Teams
    await prisma.team.createMany({
        data: [
            { id: 1, name: 'Enterprise Sales', businessUnitId: 28, departmentId: null, abbreviation: 'ES', isDeleted: true },
            { id: 2, name: 'HACO-HRA', businessUnitId: 28, departmentId: 29, abbreviation: 'HACO-HRA', isDeleted: false },
            { id: 5, name: 'Executive Leadership', businessUnitId: null, departmentId: null, abbreviation: 'EXEC', isDeleted: true },
            { id: 6, name: 'Frontend Development', businessUnitId: null, departmentId: null, abbreviation: 'FE', isDeleted: true },
            { id: 11, name: 'Content Marketing', businessUnitId: null, departmentId: null, abbreviation: 'CM', isDeleted: true },
            { id: 13, name: 'Esport', businessUnitId: null, departmentId: null, abbreviation: 'gaming', isDeleted: true },
            { id: 17, name: 'FrontendDevelopment', businessUnitId: null, departmentId: null, abbreviation: 'FE', isDeleted: true },
            { id: 34, name: 'Frontend Development3', businessUnitId: null, departmentId: null, abbreviation: 'FD', isDeleted: true },
            { id: 40, name: 'HIBC-SDEV', businessUnitId: 35, departmentId: 30, abbreviation: 'HIBC-SDEV', isDeleted: false },
            { id: 41, name: 'HIBC-CCC', businessUnitId: 35, departmentId: 27, abbreviation: 'HIBC-CCC', isDeleted: false },
            { id: 42, name: 'HIBC-EXO', businessUnitId: 35, departmentId: 26, abbreviation: 'HIBC-EXO', isDeleted: false },
            { id: 70, name: 'HIBC-HRA', businessUnitId: 35, departmentId: 29, abbreviation: 'HIBC-HRA', isDeleted: false },
            { id: 71, name: 'HIBC-FAC', businessUnitId: 35, departmentId: 28, abbreviation: 'HIBC-FAC', isDeleted: false }
        ],
        skipDuplicates: true,
    });
    // 4) Seed Statuses
    await prisma.status.createMany({
        data: [
            { id: 1, name: 'Draft', description: 'Draft' },
            { id: 3, name: 'Approved', description: 'Approved' },
            { id: 4, name: 'Rejected', description: 'Rejected' },
            { id: 5, name: 'Processing', description: 'Pending' },
            { id: 6, name: 'Recall', description: 'Recall' },
            { id: 7, name: 'Terminated', description: 'Terminate' }
        ],
        skipDuplicates: true,
    });
    // 5) Seed Users
    await prisma.user.createMany({
        data: [
            { id: 3, name: 'Phichayanit', lastname: 'Saiklaing', email: 'phichayanit.s@hylife.co.th', password: '$2b$10$fjPtvsl0UGu2AlnRK5xaqevF.6Il.Vzx69m/68ejzA.dQTVyQtZvC', role: 'admin', teamId: 41, businessUnitId: 35, departmentId: 27, nickname: 'mike' },
            { id: 12, name: 'Sarayut', lastname: 'Inmanee', email: 'sarayut.i@hylife.co.th', password: '$2b$10$br.khX.3R/7Ogq/CszeWKuN4hAS4AdJ4XSIpF4NN5e2EZU0OwJDaK', role: 'admin', teamId: 40, businessUnitId: 35, departmentId: 30, nickname: 'boss' },
            { id: 22, name: 'Weerachai', lastname: 'Tamboon', email: 'weerachai.t@hylife.co.th', password: '$2b$10$UfzfJMsEsrcEF5xKDz.WnuFalreIxMe/ngpMS0SESz5M7/RKV1.96', role: 'user', teamId: 40, businessUnitId: 35, departmentId: 30, nickname: 'mac' },
            { id: 23, name: 'Kampanat', lastname: 'Kawai', email: 'kampanat.k@hylife.co.th', password: '$2b$10$t842epC2j3gtH.W1gVJGq.7/JLlNUh3n4ezvBwxN9uBSDYXFjK3Sq', role: 'manager', teamId: 41, businessUnitId: 35, departmentId: 27, nickname: 'karn' },
            { id: 45, name: 'Suparada', lastname: 'Butbandit', email: 'suparada.b@hylife.co.th', password: '$2b$10$nh/thwtguTPnwoZe2L7hdO1ln03GSa0ZNNSYnr6Z2vtirF4x.Zwh.', role: 'user', teamId: 40, businessUnitId: 35, departmentId: 30, nickname: 'pair' }
        ],
        skipDuplicates: true,
    });
    // 6) Seed Memo Types
    await prisma.memoType.createMany({
        data: [
            { id: 1, teamId: 2, name: 'Purchase Request', abbreviation: 'PR', description: 'Purchase Request NAJA', createdByUserId: 22, isActive: true },
            { id: 2, teamId: 2, name: 'Reports', abbreviation: 'RP', description: 'รายงานผลการดำเนินการ', createdByUserId: 22, isActive: true },
            { id: 3, teamId: 2, name: 'Technical Manuals', abbreviation: 'TM', description: 'คู่มือทางเทคนิคหรือการใช้งานระบบ', createdByUserId: 22, isActive: true },
            { id: 4, teamId: 2, name: 'Work Instructions', abbreviation: 'WI', description: 'ขั้นตอนการทำงาน', createdByUserId: 22, isActive: true },
            { id: 5, teamId: 40, name: 'test document', abbreviation: 'DOC', description: 'testtest', createdByUserId: 45, isActive: true },
            { id: 6, teamId: 41, name: 'Memorandum', abbreviation: 'MEMO', description: 'บันทึกข้อความ', createdByUserId: 3, isActive: true },
            { id: 7, teamId: 41, name: 'Internal Letter', abbreviation: 'IL', description: 'หนังสือภายใน', createdByUserId: 3, isActive: true },
            { id: 8, teamId: 41, name: 'Official Letter', abbreviation: ' OL', description: 'หนังสือราชการ', createdByUserId: 3, isActive: true },
            { id: 9, teamId: 41, name: 'External Letter', abbreviation: 'EL', description: 'หนังสือภายนอก', createdByUserId: 3, isActive: true },
            { id: 10, teamId: 41, name: 'Meeting Minutes', abbreviation: 'MOM', description: 'รายงานการประชุม', createdByUserId: 3, isActive: true },
            { id: 11, teamId: 41, name: 'General Approval Form', abbreviation: 'GAF', description: 'ใบขออนุมัติทั่วไป', createdByUserId: 3, isActive: true },
            { id: 12, teamId: 41, name: 'Expense Approval Form', abbreviation: 'EAF', description: 'ใบขออนุมัติค่าใช้จ่าย', createdByUserId: 3, isActive: true },
            { id: 13, teamId: 41, name: 'Petty Cash Requisition', abbreviation: 'PCR', description: 'ใบเบิกเงินสดย่อย', createdByUserId: 3, isActive: true },
            { id: 14, teamId: 41, name: 'Receipt Voucher', abbreviation: 'RV', description: 'ใบสำคัญรับเงิน', createdByUserId: 3, isActive: true },
            { id: 15, teamId: 41, name: 'Invoice', abbreviation: 'INV', description: 'ใบแจ้งหนี้', createdByUserId: 3, isActive: true },
            { id: 16, teamId: 2, name: 'Quality Policy', abbreviation: 'QP', description: 'เอกสารนโยบายคุณภาพ', createdByUserId: 3, isActive: true },
            { id: 17, teamId: 2, name: 'Quality Manual', abbreviation: 'QM', description: 'คู่มือคุณภาพ', createdByUserId: 3, isActive: true },
            { id: 18, teamId: 70, name: 'Work Instructions', abbreviation: 'WI', description: 'ขั้นตอนการทำงาน', createdByUserId: 3, isActive: true },
            { id: 19, teamId: 70, name: 'Reports', abbreviation: 'RP', description: 'รายงานผลการดำเนินการ', createdByUserId: 3, isActive: true },
            { id: 20, teamId: 2, name: 'External Documents', abbreviation: 'ED', description: 'เอกสารจากภายนอก เช่น กฎหมาย มาตรฐาน', createdByUserId: 3, isActive: true },
            { id: 21, teamId: 70, name: 'Technical Manuals', abbreviation: 'TM', description: 'คู่มือทางเทคนิคหรือการใช้งานระบบ', createdByUserId: 3, isActive: true },
            { id: 22, teamId: 41, name: 'Billing Note', abbreviation: 'BN', description: 'ใบวางบิล', createdByUserId: 3, isActive: true },
            { id: 23, teamId: 41, name: 'Purchase Requisition', abbreviation: ' PR', description: 'ใบขอซื้อ', createdByUserId: 3, isActive: true },
            { id: 24, teamId: 41, name: 'Purchase Order', abbreviation: 'PO', description: 'ใบสั่งซื้อ', createdByUserId: 3, isActive: true },
            { id: 25, teamId: 41, name: 'Delivery Note', abbreviation: 'D', description: 'ใบส่งของ', createdByUserId: 3, isActive: true },
            { id: 26, teamId: 41, name: 'Official Receipt', abbreviation: 'OR', description: 'ใบเสร็จรับเงิน', createdByUserId: 3, isActive: true },
            { id: 27, teamId: 41, name: 'Leave Form', abbreviation: 'LF', description: 'ใบลา', createdByUserId: 3, isActive: true },
            { id: 28, teamId: 41, name: 'Timesheet', abbreviation: 'TS', description: 'ใบลงเวลาทำงาน', createdByUserId: 3, isActive: true },
            { id: 29, teamId: 41, name: 'Vehicle/Travel Request Form', abbreviation: 'TRF', description: 'แบบฟอร์มขอใช้พาหนะ / เดินทาง', createdByUserId: 3, isActive: true },
            { id: 30, teamId: 41, name: 'Meeting Room Booking Form', abbreviation: 'MRB', description: 'แบบฟอร์มขอใช้ห้องประชุม', createdByUserId: 3, isActive: true },
            { id: 31, teamId: 41, name: 'Handover Document', abbreviation: 'HOD', description: 'ใบส่งมอบงาน / ส่งมอบทรัพย์สิน', createdByUserId: 3, isActive: true },
            { id: 32, teamId: 41, name: 'Power of Attorney', abbreviation: 'POA', description: 'หนังสือมอบอำนาจ', createdByUserId: 3, isActive: true },
            { id: 33, teamId: 41, name: 'Contract', abbreviation: 'CT', description: 'เอกสารสัญญา', createdByUserId: 3, isActive: true },
            { id: 34, teamId: 41, name: 'Agreement', abbreviation: 'AG', description: 'ข้อตกลง', createdByUserId: 3, isActive: true },
            { id: 35, teamId: 40, name: 'PR', abbreviation: 'Purchase Request', description: 'Purchase Request', createdByUserId: 22, isActive: true },
            { id: 36, teamId: 2, name: 'Contract', abbreviation: 'CT', description: 'เอกสารสัญญา\n', createdByUserId: 22, isActive: true },
            { id: 37, teamId: 2, name: 'Power of Attorney', abbreviation: 'POA', description: 'หนังสือมอบอำนาจ\n', createdByUserId: 22, isActive: true },
            { id: 38, teamId: 2, name: 'Handover Document', abbreviation: 'HOD', description: 'ใบส่งมอบงาน / ส่งมอบทรัพย์สิน\n', createdByUserId: 22, isActive: true },
            { id: 39, teamId: 2, name: 'Meeting Room Booking Form', abbreviation: 'MRB', description: 'แบบฟอร์มขอใช้ห้องประชุม\n', createdByUserId: 22, isActive: true },
            { id: 40, teamId: 2, name: 'Vehicle/Travel Request Form', abbreviation: 'TRF', description: 'แบบฟอร์มขอใช้พาหนะ / เดินทาง\n', createdByUserId: 22, isActive: true },
            { id: 41, teamId: 2, name: 'Timesheet', abbreviation: 'TS', description: 'ใบลงเวลาทำงาน\n', createdByUserId: 22, isActive: true },
            { id: 42, teamId: 2, name: 'Leave Form', abbreviation: 'LF', description: 'ใบลา\n', createdByUserId: 22, isActive: true },
            { id: 43, teamId: 2, name: 'Official Receipt', abbreviation: 'OR', description: 'ใบเสร็จรับเงิน\n', createdByUserId: 22, isActive: true },
            { id: 44, teamId: 2, name: 'Delivery Note', abbreviation: 'DN', description: 'ใบส่งของ\n', createdByUserId: 22, isActive: true },
            { id: 45, teamId: 2, name: 'Purchase Order', abbreviation: 'PO', description: 'ใบสั่งซื้อ\n', createdByUserId: 22, isActive: true },
            { id: 46, teamId: 2, name: 'Billing Note', abbreviation: 'BN', description: 'ใบวางบิล\n', createdByUserId: 22, isActive: true },
            { id: 47, teamId: 2, name: 'Technical Manuals', abbreviation: 'TM', description: 'คู่มือทางเทคนิคหรือการใช้งานระบบ\n', createdByUserId: 22, isActive: true },
            { id: 48, teamId: 2, name: 'External Documents', abbreviation: 'ED', description: 'เอกสารจากภายนอก เช่น กฎหมาย มาตรฐาน\n', createdByUserId: 22, isActive: true },
            { id: 49, teamId: 2, name: 'Reports', abbreviation: 'RP', description: 'รายงานผลการดำเนินการ\n', createdByUserId: 22, isActive: true },
            { id: 50, teamId: 40, name: 'test', abbreviation: 'DT', description: 'test', createdByUserId: 45, isActive: true }
        ],
        skipDuplicates: true,
    });
    // 7) Seed Approval Action Status
    await prisma.approvalActionStatus.createMany({
        data: [
            { id: 1, code: 'waiting', label: 'Waiting', isFinal: false, createdAt: new Date('2025-08-15 11:18:24.997'), updatedAt: new Date('2025-08-15 11:18:24.997') },
            { id: 2, code: 'approved', label: 'Approved', isFinal: false, createdAt: new Date('2025-08-15 11:18:40.338'), updatedAt: new Date('2025-08-15 11:18:40.338') },
            { id: 3, code: 'rejected', label: 'Rejected', isFinal: false, createdAt: new Date('2025-08-15 11:18:57.386'), updatedAt: new Date('2025-08-15 11:18:57.386') },
            { id: 4, code: 'recalled', label: 'Recalled', isFinal: false, createdAt: new Date('2025-08-15 11:19:16.625'), updatedAt: new Date('2025-08-15 11:19:16.625') },
            { id: 5, code: 'terminated', label: 'Terminated', isFinal: false, createdAt: new Date('2025-08-15 11:19:39.855'), updatedAt: new Date('2025-08-15 11:19:39.855') }
        ],
        skipDuplicates: true,
    });

    // 8) Seed Notification Types
    await prisma.notificationType.createMany({
        data: [
            { id: 1, name: 'Wait For Yuor Turn', description: 'แจ้งเมื่อถึงคิวอนุมัติ', createdAt: new Date('2025-08-15 11:27:25.324'), updatedAt: new Date('2025-08-15 11:27:25.324') },
            { id: 2, name: 'New Comment', description: 'มีคอมเมนต์ใหม่', createdAt: new Date('2025-08-15 11:27:45.748'), updatedAt: new Date('2025-08-15 11:27:45.748') },
            { id: 3, name: 'Status Update', description: 'สถานะเอกสารถูกเปลี่ยน', createdAt: new Date('2025-08-15 11:28:19.261'), updatedAt: new Date('2025-08-15 11:28:19.261') }
        ],
        skipDuplicates: true,
    });

    // 9) Seed Line of Approval
    await prisma.lineOfApproval.createMany({
        data: [
            { id: 1, name: 'test line approve', teamId: 40, userId: 45, businessUnitId: 35, createdAt: new Date('2025-08-15 03:54:11.662'), updatedAt: new Date('2025-08-15 06:55:52.26') },
            { id: 2, name: 'test 2', teamId: 41, userId: 23, businessUnitId: 35, createdAt: new Date('2025-08-15 03:56:22.546'), updatedAt: new Date('2025-08-15 06:26:13.952') },
            { id: 3, name: 'WI Approval', teamId: 2, userId: 22, businessUnitId: 28, createdAt: new Date('2025-08-15 04:02:58.903'), updatedAt: new Date('2025-08-15 04:02:58.903') },
            { id: 4, name: 'edit', teamId: 41, userId: 12, businessUnitId: 35, createdAt: new Date('2025-08-15 04:22:23.352'), updatedAt: new Date('2025-08-15 04:22:23.352') },
            { id: 5, name: 'Approval', teamId: 41, userId: 3, businessUnitId: 35, createdAt: new Date('2025-08-15 04:23:00.682'), updatedAt: new Date('2025-08-15 04:23:00.682') },
            { id: 6, name: 'gg', teamId: 40, userId: 12, businessUnitId: 35, createdAt: new Date('2025-08-15 04:23:22.979'), updatedAt: new Date('2025-08-15 10:07:11.742') },
            { id: 7, name: 'testtest', teamId: 40, userId: 45, businessUnitId: 35, createdAt: new Date('2025-08-15 08:09:23.105'), updatedAt: new Date('2025-08-15 08:09:23.105') },
            { id: 8, name: 'test', teamId: 40, userId: 45, businessUnitId: 35, createdAt: new Date('2025-08-15 08:10:36.216'), updatedAt: new Date('2025-08-15 08:10:36.216') }
        ],
        skipDuplicates: true,
    });

    console.log('✅ Seed data created successfully.');
}
main()
    .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
})
    .finally(async () => {
    await prisma.$disconnect();
});
