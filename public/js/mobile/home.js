// Phone · Home: today's sales, what to do now, what the AI did, the latest orders.
import { get } from "../api.js";
import { esc, taka, num, greeting, onAction } from "../ui.js";
import { session } from "../app.js";
import { row, leadIcon, title, orderRow } from "./kit.js";

const timeText = (min) => (min >= 60 ? `${Math.floor(min / 60)}h ${min % 60 ? `${min % 60}m` : ""}` : `${min}m`);

export async function render(root) {
  onAction(root, { open: (el) => (location.hash = `orders?open=${el.dataset.id}`) });
  const o = await get("/api/overview?period=today");
  const first = String(session.me?.user?.name || "").split(" ")[0];

  // Only what needs doing: an empty list means you are free
  const todo = [
    ["orders?status=pending", "phone", "amber", "Call to confirm", o.todo.toCall, "orders waiting for your call"],
    ["inbox?tab=needs_human", "chats", "red", "Chats need you", o.todo.needsHuman, "the AI handed them to you"],
    ["comments", "comments", "blue", "Comments to answer", o.todo.newComments, "complaints and questions"],
    ["orders?status=confirmed", "box", "purple", "Orders to pack", Math.max(0, (o.todo.toPack || 0) - (o.todo.toCall || 0)), "confirmed, not packed yet"],
    ["inventory?low=1", "inventory", "pink", "Running low", o.todo.lowStock, "products almost sold out"],
  ].filter((t) => t[4] > 0);

  root.innerHTML = `<div class="m-screen">
    <section class="m-hello"><p>${greeting()}</p><h1>${esc(first || "Hello")} 👋</h1></section>

    <a class="m-hero" href="#orders">
      <span class="m-hero-label">Today's sales</span>
      <b class="m-hero-num">${taka(o.sales.revenue)}</b>
      <span class="m-hero-stats">
        <span><b>${num(o.sales.orders)}</b>orders</span>
        <span><b>${num(o.ai.replies)}</b>AI replies</span>
        <span><b>${o.ai.minutesSaved ? timeText(o.ai.minutesSaved) : "0m"}</b>time saved</span>
      </span>
    </a>

    ${setupCard(o.setup)}

    ${todo.length || o.setup.page ? `${title("Do now")}
    <div class="m-list">${todo.length
      ? todo.map(([href, ic, tone, label, n, hint]) => row({ href: `#${href}`, lead: leadIcon(ic, tone), title: label, sub: hint, side: `<span class="m-count tone-${tone}">${n}</span>` })).join("")
      : row({ href: "#inbox", lead: leadIcon("check", "green"), title: "All caught up", sub: "The AI is answering your customers", chevron: false })}</div>` : ""}

    ${title("Latest orders", `<a href="#orders">See all</a>`)}
    <div class="m-list">${o.recentOrders.slice(0, 4).map((x) => orderRow(x)).join("") || `<p class="m-empty">No orders yet. They appear here when the AI takes one.</p>`}</div>
  </div>`;
}

// Shown until the 4 first steps are done
function setupCard(setup) {
  const steps = [["page", "Connect your Facebook Page", "#accounts"], ["products", "Add your products", "#inventory?add=1"], ["knowledge", "Train the AI on your shop", "#train"], ["chat", "Test the AI", "#inbox?simulate=1"]];
  const done = steps.filter(([k]) => setup[k]).length;
  if (done === steps.length) return "";
  const next = steps.find(([k]) => !setup[k]);
  return `<a class="m-setup" href="${next[2]}">
    <span class="m-setup-top"><b>Finish setup</b><span>${done} of ${steps.length}</span></span>
    <span class="m-progress"><i style="width:${(done / steps.length) * 100}%"></i></span>
    <span class="m-setup-next">Next: ${esc(next[1])} →</span></a>`;
}
