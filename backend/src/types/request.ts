import { Request } from "express";

export interface AuthenticatedRequest extends Request {
  user?: {
    teamId?: number
    id: number;
    name: string;
    role: string;
    businessUnitId: number;
  };
}