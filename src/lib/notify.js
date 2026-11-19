// Bell notifications shown in the dashboard. They also go to the shop's phones / computers
// that turned alerts on (services/push.js), unless { push: false }.
const { Notification } = require("../models");

async function notify(organizationId, title, message = "", view = null, { push = true } = {}) {
  await Notification.create({ organizationId, title, message: String(message).slice(0, 300), view })
    .catch((e) => console.warn("notify:", e.message));
  if (push) {
    require("../services/push").pushToShop(organizationId, { title, body: String(message).slice(0, 160), url: view ? `/#${view}` : "/" })
      .catch((e) => console.warn("push:", e.message));
  }
}

module.exports = { notify };
