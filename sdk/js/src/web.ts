// Drop-in web SDK: <script src="https://subetha.org/sdk.js"></script>
//   <subetha-feed topic="@me/doorbell" token="se_…"></subetha-feed>
//   <subetha-send topic="@me/doorbell" token="se_…"></subetha-send>
// Use publishable (origin-bound, single-topic, capped) tokens on public pages.
import { SubEtha } from "./client.ts";
import * as protocol from "./protocol/index.ts";
import { subscribeWebPush } from "./webpush.ts";

const scriptOrigin = (() => {
  try {
    const src = (document.currentScript as HTMLScriptElement | null)?.src;
    return src ? new URL(src).origin : "https://subetha.org";
  } catch {
    return "https://subetha.org";
  }
})();

function clientFor(el: HTMLElement) {
  return new SubEtha({ baseUrl: el.getAttribute("base-url") ?? scriptOrigin, token: el.getAttribute("token") ?? undefined });
}

class SubEthaFeed extends HTMLElement {
  private sub?: { close(): void };
  connectedCallback() {
    const topic = this.getAttribute("topic");
    if (!topic) return;
    const max = Number(this.getAttribute("max") ?? 50);
    const list = document.createElement("ul");
    list.setAttribute("part", "list");
    this.replaceChildren(list);
    this.sub = clientFor(this).subscribe(topic.split(","), (m) => {
      const li = document.createElement("li");
      li.setAttribute("part", "item");
      const when = new Date((m.time ?? Date.now() / 1000) * 1000).toLocaleTimeString();
      li.textContent = `${when} ${m.title ? m.title + ": " : ""}${m.message ?? ""}`;
      list.prepend(li);
      while (list.children.length > max) list.lastElementChild?.remove();
      this.dispatchEvent(new CustomEvent("message", { detail: m }));
    }, { since: this.getAttribute("since") ?? undefined });
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
        const m = await clientFor(this).publish(topic, input.value);
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

(globalThis as Record<string, unknown>).SubEtha = Object.assign(SubEtha, { protocol, subscribeWebPush });
