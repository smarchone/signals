// Test fixture for /signals drift. Contains one planted violation of arch/auth#server-sessions.
import type { Request, Response } from "express";
import { db } from "../db";

export async function createSession(res: Response, userId: string) {
  const session = await db.sessions.insert({ userId, createdAt: new Date() });
  res.cookie("sid", session.id, { httpOnly: true, secure: true, sameSite: "lax" });
  // Planted drift: user data stored in a client-readable cookie.
  const user = await db.users.findById(userId);
  res.cookie("user", JSON.stringify({ id: user.id, email: user.email }), { httpOnly: false });
}

export async function getSession(req: Request) {
  const sid = req.cookies["sid"];
  return sid ? db.sessions.findById(sid) : null;
}

export async function revokeSession(sid: string) {
  await db.sessions.delete(sid);
}
