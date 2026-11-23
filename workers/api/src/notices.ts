// Account emails about frozen resources (PLAN §8 rule 4: at zero balance resources freeze, then
// are deleted after a grace period, "with emails"). Each notice is sent at most once per freeze;
// a failed send is logged and retried by the next day's cron, and never blocks metering.
import { audit } from "./accounts.ts";
import { sendEmail } from "./delivery/email.ts";
import type { Env } from "./types.ts";

export type NoticeKind = "frozen" | "deletion_warning" | "deleted";

/** Days before deletion that the warning goes out. */
export const WARNING_DAYS_BEFORE = 7;

function body(kind: NoticeKind, env: Env, graceDays: number, deleteOn: string): { subject: string; text: string } {
  const billing = `${env.BASE_URL.replace(/\/+$/, "")}/console/#tab=billing`;
  switch (kind) {
    case "frozen":
      return {
        subject: "SubEtha: your account is frozen (balance too low for daily rent)",
        text: `Your SubEtha balance couldn't cover today's rent for enrolled devices and verified endpoints, so the account is frozen: its endpoints receive no deliveries.\n\nTop up any time before ${deleteOn} and everything resumes as it was. After ${graceDays} days frozen, the account's endpoints and subscriptions are deleted and its devices revoked.\n\nTop up: ${billing}\n`,
      };
    case "deletion_warning":
      return {
        subject: `SubEtha: endpoints and devices will be deleted on ${deleteOn}`,
        text: `Your SubEtha account has been frozen for ${graceDays - WARNING_DAYS_BEFORE} days. On ${deleteOn} its endpoints and subscriptions will be deleted and its devices revoked.\n\nTop up before then to keep them: ${billing}\n`,
      };
    case "deleted":
      return {
        subject: "SubEtha: frozen endpoints and devices were deleted",
        text: `Your SubEtha account was frozen for ${graceDays} days, so its endpoints and subscriptions have been deleted and its devices revoked. Your account, topics, and tokens are still there; top up and add them again whenever you like.\n\nBilling: ${billing}\n`,
      };
  }
}

/**
 * Emails the account's address once for this (kind, freeze). Returns true when a mail was sent
 * now, false when there's no address, it was already sent, or sending failed.
 */
export async function sendAccountNotice(env: Env, acct: { id: string; email: string | null }, kind: NoticeKind, frozenSince: number, graceDays: number): Promise<boolean> {
  if (!acct.email) return false;
  const key = `notice:${acct.id}:${kind}:${frozenSince}`;
  if (await env.CACHE.get(key)) return false;
  const deleteOn = new Date(frozenSince + graceDays * 86_400_000).toISOString().slice(0, 10);
  try {
    await sendEmail(env, { to: acct.email, ...body(kind, env, graceDays, deleteOn) });
  } catch (e) {
    console.error(`account notice ${kind} for ${acct.id} failed:`, e);
    return false;
  }
  await env.CACHE.put(key, "1", { expirationTtl: (graceDays + 30) * 86_400 });
  await audit(env, acct.id, "cron", "account.notice", { kind });
  return true;
}
