const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']); // Use Google DNS


// ... rest of your code
const {
  Organization,
  Lead,
  Task,
  ContentItem,
  WebhookEvent,
  SocialAccount,
} = require("./schema.js");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ==========================================
// Connect to MongoDB
// ==========================================
mongoose
  .connect(process.env.DATABASE_URL)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  });

// ==========================================
// ENDPOINT 1: Deduplication Check
// ==========================================
app.post("/api/leads/check-duplicate", async (req, res) => {
  const { tenantId, eventId } = req.body;
  try {
    const existingEvent = await WebhookEvent.findOne({ externalEventId: eventId });
    if (existingEvent) return res.json({ isDuplicate: true });

    await WebhookEvent.create({
      tenantId,
      externalEventId: eventId,
      provider: "n8n",
      processingStatus: "processed",
    });

    return res.json({ isDuplicate: false });
  } catch (error) {
    console.error("Dedupe Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ==========================================
// ENDPOINT 2: Save Lead with AI Score
// ==========================================
app.post("/api/leads/create", async (req, res) => {
  const { tenantId, leadId, name, email, aiScore, aiStatus, aiReason } = req.body;
  try {
    const newLead = await Lead.create({
      _id: leadId,
      organizationId: tenantId,
      name,
      email,
      aiScore: parseInt(aiScore, 10) || 0,
      aiStatus: aiStatus || "Cold",
      aiReason,
    });
    res.json({ success: true, lead: newLead });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: "Lead already exists" });
    console.error("Lead Save Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ==========================================
// ENDPOINT 3: Create CRM Task
// ==========================================
app.post("/api/tasks/create", async (req, res) => {
  const { tenantId, leadId, title, priority } = req.body;
  try {
    const newTask = await Task.create({
      organizationId: tenantId,
      leadId: leadId || null,
      title,
      priority: priority || "High",
    });
    res.json({ success: true, task: newTask });
  } catch (error) {
    console.error("Task Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ==========================================
// ENDPOINT 4: Save AI Generated Content (embedded variants)
// ==========================================
app.post("/api/content/create", async (req, res) => {
  const { tenantId, platform, topic, generatedText } = req.body;
  try {
    const newContent = await ContentItem.create({
      organizationId: tenantId,
      title: topic,
      body: generatedText,
      status: "Draft",
      variants: [{ platform, caption: generatedText }],
    });
    res.json({ success: true, content: newContent });
  } catch (error) {
    console.error("Content Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ==========================================
// ENDPOINT 5: Get All Leads
// ==========================================
app.get("/api/leads", async (_req, res) => {
  try {
    const leads = await Lead.find().sort({ createdAt: -1 });
    res.json(leads);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch leads" });
  }
});

// ==========================================
// ENDPOINT 6: Get All Content
// ==========================================
app.get("/api/content", async (_req, res) => {
  try {
    const content = await ContentItem.find().sort({ createdAt: -1 });

    const formattedContent = content.map((item) => ({
      id: String(item._id),
      platform: item.variants?.[0]?.platform || "General",
      topic: item.title,
      generatedText: item.body,
      status: item.status,
      createdAt: item.createdAt,
    }));

    res.json(formattedContent);
  } catch (error) {
    console.error("Fetch Content Error:", error);
    res.status(500).json({ error: "Failed to fetch content" });
  }
});

// ==========================================
// ENDPOINT 9: Save a Connected Account
// ==========================================
app.post("/api/integrations/connect", async (req, res) => {
  const { organizationId, platform, accountName, accountId, accessToken } = req.body;
  try {
    const newAccount = await SocialAccount.create({
      organizationId,
      platform,
      accountName,
      accountId,
      accessToken,
    });
    res.json({ success: true, account: newAccount });
  } catch (error) {
    console.error("Connect Account Error:", error);
    res.status(500).json({ error: "Failed to connect account" });
  }
});

// ==========================================
// ENDPOINT 10: Get All Connected Accounts
// ==========================================
app.get("/api/integrations", async (_req, res) => {
  try {
    const accounts = await SocialAccount.find({ organizationId: "org_123" });
    res.json(accounts);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch accounts" });
  }
});

// ==========================================
// ENDPOINT 7: Approve Content & Send to Facebook
// ==========================================
app.put("/api/content/:id/approve", async (req, res) => {
  const { id } = req.params;
  const { platform } = req.body;
  try {
    const updatedContent = await ContentItem.findByIdAndUpdate(
      id,
      { status: "Approved" },
      { new: true }
    );
    if (!updatedContent) return res.status(404).json({ error: "Content not found" });

    const account = await SocialAccount.findOne({
      organizationId: "org_123",
      platform,
    });
    if (!account) {
      return res.status(400).json({ error: "No account connected for this platform" });
    }

    await fetch("http://localhost:5678/webhook-test/publish-facebook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        postText: updatedContent.body,
        pageId: account.accountId,
        accessToken: account.accessToken,
      }),
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Approve Error:", error);
    res.status(500).json({ error: "Failed to approve" });
  }
});

// ==========================================
// ENDPOINT 8: Dashboard Analytics (KPIs)
// ==========================================
app.get("/api/stats", async (_req, res) => {
  try {
    const [totalLeads, hotLeads, totalContent, publishedContent] = await Promise.all([
      Lead.countDocuments(),
      Lead.countDocuments({ aiStatus: "Hot" }),
      ContentItem.countDocuments(),
      ContentItem.countDocuments({ status: "Approved" }),
    ]);
    res.json({ totalLeads, hotLeads, totalContent, publishedContent });
  } catch (error) {
    console.error("Stats Error:", error);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// ==========================================
// Start Server
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
});