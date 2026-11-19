// Phone · More: your account and everything that isn't in the bottom bar (posts, comments, setup).
import { post } from "../api.js";
import { esc, onAction, confirmBox } from "../ui.js";
import { session } from "../app.js";
import { row, leadIcon, title } from "./kit.js";
import { drawAlertsBox } from "../alerts.js";

export async function render(root) {
  onAction(root, {
    logout: async () => { if (!(await confirmBox("Log out of MarketingFlow?", "Log out", false))) return; await post("/api/auth/logout"); location.reload(); },
  });
  const me = session.me || { user: { name: "" } };
  const link = (href, ic, tone, label, sub = "") => row({ href, lead: leadIcon(ic, tone), title: label, sub });

  root.innerHTML = `<div class="m-screen">
    <div class="m-profile">
      <span class="m-avatar">${esc((me.user.name || "?")[0].toUpperCase())}</span>
      <span class="m-main"><b>${esc(me.user.name)}</b><small>${esc(me.business || "")}${me.user.email ? ` · ${esc(me.user.email)}` : ""}</small></span>
    </div>

    <div class="alerts-box mt" id="alertsBox"></div>

    ${title("Shop")}
    <div class="m-list">
      ${link("#content", "content", "accent", "Posts", "Write with AI, publish to Facebook & Instagram")}
      ${link("#customers", "user", "green", "Customers", "Everyone who ordered, with their orders")}
      ${link("#comments", "comments", "blue", "Comments", "Replies to your post comments")}
    </div>

    ${title("Setup")}
    <div class="m-list">
      ${link("#accounts", "accounts", "blue", "Facebook & Instagram", "Connect your Page and Instagram")}
      ${link("#train", "train", "purple", "AI Training", "Teach the AI what it didn't know")}
      ${link("#settings", "settings", "grey", "Settings", "AI, delivery fees, business, password")}
      ${link("#look", "look", "pink", "Look", "Colours and text size")}
    </div>

    ${me.user.isAdmin ? `${title("Super Admin")}<div class="m-list">
      ${link("#admin-customers", "admin-customers", "grey", "Shops")}
      ${link("#admin-pages", "admin-pages", "grey", "All Pages")}</div>` : ""}

    <div class="m-list mt">${row({ action: "logout", lead: leadIcon("logout", "red"), title: "Log out", chevron: false, cls: "danger" })}</div>
    <p class="m-foot">MarketingFlow AI</p>
  </div>`;
  drawAlertsBox(root.querySelector("#alertsBox"));
}
