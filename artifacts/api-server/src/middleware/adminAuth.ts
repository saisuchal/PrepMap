import { type Request, type Response, type NextFunction } from "express";
import { db, usersTable } from "../db";
import { eq } from "drizzle-orm";
import { getJwtRequestAuth } from "../lib/requestAuth";

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const auth = getJwtRequestAuth(req);
  const userId = auth?.userId || "";

  if (!userId) {
    res.status(401).json({ error: "Authentication required. Provide a valid bearer token." });
    return;
  }

  try {
    const [user] = await db
      .select({ id: usersTable.id, role: usersTable.role })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    if (!user) {
      res.status(401).json({ error: "Invalid user" });
      return;
    }

    const normalizedRole = String(user.role || "").trim().toLowerCase();
    if (normalizedRole !== "admin") {
      res.status(403).json({ error: "Admin access required" });
      return;
    }

    (req as any).userId = user.id;
    (req as any).authClaims = auth?.claims ?? null;
    next();
  } catch (error: any) {
    req.log.error(
      {
        err: error,
        userId,
        dbCause: error?.cause?.message || null,
        dbCode: error?.cause?.code || null,
      },
      "Admin auth database lookup failed",
    );
    res.status(500).json({ error: "Authentication lookup failed" });
  }
}

