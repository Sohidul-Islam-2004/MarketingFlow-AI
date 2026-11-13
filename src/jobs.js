// Background jobs that run while the server is on. Turn off with JOBS=off in .env.
const { Conversation } = require("./models");
const { publishDuePosts } = require("./services/publisher");
const { sendWaitingReplies } = require("./services/comments");
const { checkAllPages } = require("./routes/meta");

const running = new Set();
// Runs a job unless the previous run of the same job is still busy
async function run(name, job) {
  if (running.has(name)) return;
  running.add(name);
  try { await job(); } catch (e) { console.error(`job ${name}:`, e.message); } finally { running.delete(name); }
}

// Chats with no activity for 3 days are closed (a new message opens them again)
const closeOldChats = () => Conversation.updateMany({ status: "open", updatedAt: { $lt: new Date(Date.now() - 72 * 3600e3) } }, { status: "closed" }, { timestamps: false });

function startJobs() {
  setInterval(() => run("publish", publishDuePosts), 30 * 1000);
  setInterval(() => run("comment replies", sendWaitingReplies), 10 * 1000);
  setInterval(() => run("close old chats", closeOldChats), 60 * 60 * 1000);
  setInterval(() => run("check Page tokens", checkAllPages), 6 * 60 * 60 * 1000); // finds expired tokens for the Admin page
  console.log("⏱️  Jobs on: publish posts every 30s, comment replies every 10s");
}

module.exports = { startJobs };
