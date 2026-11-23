// Drop-in web SDK: <script src="https://subetha.us/sdk.js"></script>
//   <subetha-feed topic="@me/doorbell" token="se_…"></subetha-feed>
//   <subetha-send topic="@me/doorbell" token="se_…"></subetha-send>
// Use publishable (origin-bound, single-topic, capped) tokens on public pages.
import { enrollmentProof, SubEtha } from "./client.ts";
import * as protocol from "./protocol/index.ts";
import { subscribeWebPush } from "./webpush.ts";

const scriptOrigin = (() => {
  try {
    const src = (document.currentScript as HTMLScriptElement | null)?.src;
    return src ? new URL(src).origin : "https://subetha.us";
  } catch {
    return "https://subetha.us";
  }
})();

function clientFor(el: HTMLElement) {
  return new SubEtha({ baseUrl: el.getAttribute("base-url") ?? scriptOrigin, token: el.getAttribute("token") ?? undefined });
}

function safeHref(u: unknown): string | null {
  if (typeof u !== "string" || !u) return null;
  if (u.startsWith("/file/")) return u;
  try {
    const p = new URL(u);
    return p.protocol === "https:" || p.protocol === "http:" ? p.toString() : null;
  } catch { return null; }
}

function listAttr(el: HTMLElement, name: string): string[] | undefined {
  const v = el.getAttribute(name);
  if (!v) return undefined;
  const xs = v.split(",").map((s) => s.trim()).filter(Boolean);
  return xs.length ? xs : undefined;
}

class SubEthaFeed extends HTMLElement {
  private sub?: { close(): void };
  connectedCallback() {
    const topic = this.getAttribute("topic");
    if (!topic) return;
    const max = Number(this.getAttribute("max") ?? 50);
    const priority = listAttr(this, "priority")?.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 5);
    const tags = listAttr(this, "tags");
    const list = document.createElement("ul");
    list.setAttribute("part", "list");
    this.replaceChildren(list);
    this.sub = clientFor(this).subscribe(topic.split(","), (m) => {
      const li = document.createElement("li");
      li.setAttribute("part", "item");
      const when = new Date((m.time ?? Date.now() / 1000) * 1000).toLocaleTimeString();
      li.append(document.createTextNode(`${when} ${m.title ? m.title + ": " : ""}${m.message ?? ""}`));
      const click = safeHref(m.click);
      if (click) {
        const a = document.createElement("a");
        a.href = click; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = " [open]";
        li.append(a);
      }
      const att = m.attachment && safeHref(m.attachment.url);
      if (att) {
        const a = document.createElement("a");
        a.href = att; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = ` [${m.attachment!.name || "attachment"}]`;
        li.append(a);
      }
      list.prepend(li);
      while (list.children.length > max) list.lastElementChild?.remove();
      this.dispatchEvent(new CustomEvent("message", { detail: m }));
    }, { since: this.getAttribute("since") ?? undefined, ...(priority?.length ? { priority } : {}), ...(tags?.length ? { tags } : {}) });
  }
  disconnectedCallback() {
    this.sub?.close();
  }
}

class SubEthaSend extends HTMLElement {
  connectedCallback() {
    const topic = this.getAttribute("topic");
    if (!topic) return;
    const form = document.createElement("form");
    const input = document.createElement("input");
    input.placeholder = this.getAttribute("placeholder") ?? "Message";
    input.setAttribute("part", "input");
    const button = document.createElement("button");
    button.textContent = this.getAttribute("label") ?? "Send";
    button.setAttribute("part", "button");
    form.append(input, button);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!input.value) return;
      button.disabled = true;
      try {
        const prioRaw = this.getAttribute("priority");
        const prio = prioRaw ? Number(prioRaw) : undefined;
        const m = await clientFor(this).publish(topic, input.value, {
          title: this.getAttribute("title") ?? undefined,
          priority: prio && prio >= 1 && prio <= 5 ? (prio as 1 | 2 | 3 | 4 | 5) : undefined,
          tags: listAttr(this, "tags"),
        });
        input.value = "";
        this.dispatchEvent(new CustomEvent("sent", { detail: m }));
      } catch (err) {
        this.dispatchEvent(new CustomEvent("error", { detail: err }));
      } finally {
        button.disabled = false;
      }
    });
    this.replaceChildren(form);
  }
}

if (!customElements.get("subetha-feed")) customElements.define("subetha-feed", SubEthaFeed);
if (!customElements.get("subetha-send")) customElements.define("subetha-send", SubEthaSend);

(globalThis as Record<string, unknown>).SubEtha = Object.assign(SubEtha, { protocol, subscribeWebPush, enrollmentProof });
