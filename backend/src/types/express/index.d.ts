import { JwtPayload } from "jsonwebtoken";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: number;
        name: string;
        role: string;
        businessUnitId: number;
      };
    }
  }
}

export {}; // <-- จำเป็นมากไม่งั้น ts จะเมินไฟล์นี้
