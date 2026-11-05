const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const path = require('path');
require('dotenv').config();

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

// Serve static HTML files (index.html and contact.html)
app.use(express.static(__dirname));

// ==========================================
// ENDPOINT 1: Deduplication Check
// ==========================================
app.post('/api/leads/check-duplicate', async (req, res) => {
  const { tenantId, eventId } = req.body;
  try {
    const existingEvent = await prisma.webhookEvent.findUnique({
      where: { externalEventId: eventId }
    });

    if (existingEvent) return res.json({ isDuplicate: true });

    await prisma.webhookEvent.create({
      data: {
        tenantId: tenantId,
        externalEventId: eventId,
        provider: "n8n",
        processingStatus: "processed"
      }
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
app.post('/api/leads/create', async (req, res) => {
  const { tenantId, leadId, name, email, aiScore, aiStatus, aiReason } = req.body;
  try {
    const newLead = await prisma.lead.create({
      data: {
        id: leadId,
        organizationId: tenantId, // Maps tenantId to organizationId
        name,
        email,
        aiScore: parseInt(aiScore) || 0,
        aiStatus: aiStatus || "Cold",
        aiReason
      }
    });
    res.json({ success: true, lead: newLead });
  } catch (error) {
    console.error("Lead Save Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ==========================================
// ENDPOINT 3: Create CRM Task
// ==========================================
app.post('/api/tasks/create', async (req, res) => {
  const { tenantId, leadId, title, priority } = req.body;
  try {
    const newTask = await prisma.task.create({
      data: {
        organizationId: tenantId,
        leadId: leadId,
        title: title,
        priority: priority || "High"
      }
    });
    res.json({ success: true, task: newTask });
  } catch (error) {
    console.error("Task Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ==========================================
// ENDPOINT 4: Save AI Generated Content
// ==========================================
app.post('/api/content/create', async (req, res) => {
  const { tenantId, platform, topic, generatedText } = req.body;
  try {
    // 1. Create the Main Content Item
    const newContent = await prisma.contentItem.create({
      data: {
        organizationId: tenantId,
        title: topic,       // Maps to "title" in schema
        body: generatedText, // Maps to "body" in schema
        status: "Draft"
      }
    });

    // 2. Create the Platform Variant
    await prisma.contentVariant.create({
      data: {
        contentId: newContent.id,
        platform: platform,
        caption: generatedText
      }
    });

    res.json({ success: true, content: newContent });
  } catch (error) {
    console.error("Content Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ==========================================
// ENDPOINT 5: Get All Leads (For Dashboard)
// ==========================================
app.get('/api/leads', async (req, res) => {
  try {
    const leads = await prisma.lead.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(leads);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch leads" });
  }
});

// ==========================================
// ENDPOINT 6: Get All Content (For Dashboard)
// ==========================================
app.get('/api/content', async (req, res) => {
  try {
    // Fetch ContentItems and include their platform variants
    const content = await prisma.contentItem.findMany({
      orderBy: { createdAt: 'desc' },
      include: { variants: true }
    });

    // Format it so the frontend still sees 'platform', 'topic', and 'generatedText'
    const formattedContent = content.map(item => ({
      id: item.id,
      platform: item.variants[0]?.platform || "General",
      topic: item.title,
      generatedText: item.body,
      status: item.status,
      createdAt: item.createdAt
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
app.post('/api/integrations/connect', async (req, res) => {
  const { organizationId, platform, accountName, accountId, accessToken } = req.body;
  try {
    const newAccount = await prisma.socialAccount.create({
      data: { organizationId, platform, accountName, accountId, accessToken }
    });
    res.json({ success: true, account: newAccount });
  } catch (error) {
    res.status(500).json({ error: "Failed to connect account" });
  }
});

// ==========================================
// ENDPOINT 10: Get All Connected Accounts
// ==========================================
app.get('/api/integrations', async (req, res) => {
  try {
    // For MVP, we fetch all accounts for org_123
    const accounts = await prisma.socialAccount.findMany({
      where: { organizationId: "org_123" }
    });
    console.log(accounts);
    res.json(accounts);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch accounts" });
  }
});
// ==========================================
// ENDPOINT 7: Approve Content & Send to Facebook
// ==========================================
app.put('/api/content/:id/approve', async (req, res) => {
  const { id } = req.params;
  const { platform } = req.body; // Frontend will tell us which platform to post to

  try {
    // 1. Update DB
    const updatedContent = await prisma.contentItem.update({
      where: { id: id }, data: { status: "Approved" }
    });

    // 2. Find the connected account for this platform
    const account = await prisma.socialAccount.findFirst({
      where: { organizationId: "org_123", platform: platform }
    });

    if (!account) return res.status(400).json({ error: "No account connected for this platform" });

    // 3. Send the DYNAMIC token and ID to n8n
    await fetch('http://localhost:5678/webhook-test/publish-facebook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        postText: updatedContent.body,
        pageId: account.accountId,       // <--- THIS MUST BE HERE
        accessToken: account.accessToken // <--- THIS MUST BE HERE
      })
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to approve" });
  }
});
// ==========================================
// ENDPOINT 8: Get Dashboard Analytics (KPIs)
// ==========================================
app.get('/api/stats', async (req, res) => {
  try {
    const totalLeads = await prisma.lead.count();
    const hotLeads = await prisma.lead.count({ where: { aiStatus: 'Hot' } });
    const totalContent = await prisma.contentItem.count();
    const publishedContent = await prisma.contentItem.count({ where: { status: 'Approved' } });

    res.json({
      totalLeads,
      hotLeads,
      totalContent,
      publishedContent
    });
  } catch (error) {
    console.error("Stats Error:", error);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
});


// yes cloned