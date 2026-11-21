// Importing this module registers every sender.
import "./webhook.ts";
import "./email.ts";
import "./slack.ts";
import "./twilio.ts";
import "./lxmf.ts";
import "./webpush.ts";
import "./fcm.ts";
import "./apns.ts";
export { senders, registerSender, PermanentError } from "./senders.ts";
