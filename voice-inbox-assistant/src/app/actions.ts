"use server";

import { signIn, signOut } from "@/auth";

export async function signInWithGoogle() {
  await signIn("google", { redirectTo: "/" });
}

export async function signOutAction() {
  await signOut({ redirectTo: "/" });
}

/** Clears the expired session, then starts a fresh Google sign-in (asks for consent again). */
export async function reconnectGoogle() {
  await signOut({ redirect: false });
  await signIn("google", { redirectTo: "/" });
}
