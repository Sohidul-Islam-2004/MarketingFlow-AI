// Bell notifications shown in the dashboard.
const { Notification } = require("../models");

async function notify(organizationId, title, message = "", view = null) {
  await Notification.create({ organizationId, title, message: String(message).slice(0, 300), view })
    .catch((e) => console.warn("notify:", e.message));
}

module.exports = { notify };
