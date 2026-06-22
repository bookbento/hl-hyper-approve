import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { prisma } from "../../prisma/client";
 
import { RequestHandler } from "express";
import { AuthenticatedRequest } from "../types/request";
 
const secretKey = process.env.JWT_SECRET;
if (!secretKey) {
  throw new Error("JWT_SECRET environment variable is not defined");
}
 
export const login: RequestHandler = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ message: "Email and password are required" });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }

    if (user.deletedAt) {
      res.status(403).json({ message: "Your account has been deactivated. Please contact support." });
      return;
    }

    const payload = {
      id: user.id,
      name: user.name,
      role: user.role,
      businessUnitId: user.businessUnitId,
    };

    const refreshToken = jwt.sign(payload, secretKey, { expiresIn: "7d" });

    // Set cookie after password verification
    // res.cookie("refreshToken", refreshToken, {
    //   httpOnly : true,
    //   secure   : false,
    //   sameSite : "lax",
    //   path     : "/",
    // });

    res.cookie("refreshToken", refreshToken, {
      httpOnly : true,
      secure   : process.env.NODE_ENV === "production",
      sameSite : "strict",
      path     : "/",
      maxAge : 7 * 24 * 60 * 60 * 1000, // 7 days explicit
    });

    // Record login session
    const ipAddress =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
      req.ip ??
      null;
    const userAgent = (req.headers["user-agent"] as string) ?? null;

    await prisma.loginSession.create({
      data: { userId: user.id, ipAddress, userAgent },
    });

    // Return login success with first login status
    res.json({
      message: "Login successful",
      isFirstLogin: user.isFirstLogin
    });
  } catch (error) {
    console.error("❌ Login error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};
 
export const refreshToken: RequestHandler = (req: Request, res: Response) => {
  try {
    const token = req.body.token;
    
    if (!token) {
      res.status(400).json({ message: "Token is required" });
      return;
    }

    jwt.verify(token, secretKey, (err: jwt.VerifyErrors | null, user: string | jwt.JwtPayload | undefined) => {
      if (err) {
        res.sendStatus(403);
        return;
      }
      const accessToken = jwt.sign(user as object, secretKey, { expiresIn: "1h" });
      res.json({ accessToken });
    });
  } catch (error) {
    console.error("❌ Refresh token error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};
 
export const logout: RequestHandler = async (req: Request, res: Response) => {
  try {
    const token = req.cookies?.refreshToken;

    if (token) {
      try {
        const decoded = jwt.verify(token, secretKey) as jwt.JwtPayload;
        const userId = decoded?.id as number | undefined;

        if (userId) {
          const session = await prisma.loginSession.findFirst({
            where: { userId, logoutAt: null },
            orderBy: { loginAt: "desc" },
          });

          if (session) {
            await prisma.loginSession.update({
              where: { id: session.id },
              data: { logoutAt: new Date() },
            });
          }
        }
      } catch {
        // Token expired or invalid — still clear the cookie
      }
    }

    res.clearCookie("refreshToken");
    res.sendStatus(204);
  } catch (error) {
    console.error("❌ Logout error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};
 
export const me: RequestHandler = async (req, res) => {
  const userId = (req as AuthenticatedRequest).user?.id;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
 
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      lastname: true,
      nickname: true,
      email: true,
      role: true,
      department: { select: { id: true, name: true } },
      businessUnit: { select: { id: true, name: true } },
      profileImagePath: true,
      isFirstLogin: true,
      defaultSignatureText: true,
    },
  });

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(user);
};

export const getMySessions: RequestHandler = async (req, res) => {
  const userId = (req as AuthenticatedRequest).user?.id;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const sessions = await prisma.loginSession.findMany({
      where: { userId },
      orderBy: { loginAt: "desc" },
      take: 50,
      select: {
        id: true,
        loginAt: true,
        logoutAt: true,
        ipAddress: true,
        userAgent: true,
      },
    });

    res.json({ sessions });
  } catch (error) {
    console.error("❌ Get sessions error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// First-time password change endpoint
export const changeFirstTimePassword: RequestHandler = async (req, res) => {
  const userId = (req as AuthenticatedRequest).user?.id;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { newPassword } = req.body;

  if (!newPassword || newPassword.trim().length < 6) {
    res.status(400).json({ error: "Password must be at least 6 characters long" });
    return;
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    if (!user.isFirstLogin) {
      res.status(400).json({ error: "This endpoint is only for first-time password changes" });
      return;
    }

    const hashedPassword = await bcrypt.hash(newPassword.trim(), 10);

    await prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        isFirstLogin: false
      }
    });

    // ✅ Initialize notification preferences on first password change
    try {
      const notificationTypes = await prisma.notificationType.findMany();
      
      // Check if user already has preferences (safety check)
      const existingPrefsCount = await prisma.userNotificationPreference.count({
        where: { userId }
      });

      if (existingPrefsCount === 0) {
        // Create all preferences with default value (true for all on first login)
        const defaultPreferences = notificationTypes.map((type: { id: number }) => ({
          userId,
          notificationTypeId: type.id,
          emailEnabled: true // Set everything to true on first login
        }));
        
        await prisma.userNotificationPreference.createMany({
          data: defaultPreferences,
          skipDuplicates: true
        });
        
        console.log(`✅ [First Login] Created ${defaultPreferences.length} notification preferences for user ${userId} (all enabled)`);
      } else {
        console.log(`ℹ️  [First Login] User ${userId} already has ${existingPrefsCount} preferences, skipping initialization`);
      }
    } catch (prefError) {
      // Log error but don't fail password change
      console.error('⚠️  Failed to initialize notification preferences on first login:', prefError);
    }

    res.json({ message: "Password changed successfully" });
  } catch (error) {
    console.error("Error changing first-time password:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};