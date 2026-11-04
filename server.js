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
    const existingEvent = await prisma.webhookEvent.findUnique({ where: { eventId } });
    if (existingEvent) return res.json({ isDuplicate: true });

    await prisma.webhookEvent.create({ data: { tenantId, eventId } });
    return res.json({ isDuplicate: false });
  } catch (error) {
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
      data: { id: leadId, tenantId, name, email, aiScore: parseInt(aiScore), aiStatus, aiReason }
    });
    res.json({ success: true, lead: newLead });
  } catch (error) {
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
      data: { tenantId, leadId, title, priority }
    });
    res.json({ success: true, task: newTask });
  } catch (error) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ==========================================
// ENDPOINT 4: Save AI Generated Content
// ==========================================
app.post('/api/content/create', async (req, res) => {
  const { tenantId, platform, topic, generatedText } = req.body;
  try {
    const newContent = await prisma.content.create({
      data: { tenantId, platform, topic, generatedText, status: "Draft" }
    });
    res.json({ success: true, content: newContent });
  } catch (error) {
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
    const content = await prisma.content.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(content);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch content" });
  }
});

// ==========================================
// ENDPOINT 7: Approve Content & Send to Facebook
// ==========================================
app.put('/api/content/:id/approve', async (req, res) => {
  const { id } = req.params;
  try {
    // 1. Update the database status to Approved
    const updatedContent = await prisma.content.update({
      where: { id: id },
      data: { status: "Approved" }
    });

    console.log(`✅ Content ${id} approved in database.`);

    // 2. Trigger n8n to post to Facebook
    try {
      // PRODUCTION URL (Removed -test)
      const n8nResponse = await fetch('http://localhost:5678/webhook/publish-facebook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          postText: updatedContent.generatedText
        })
      });

      if (n8nResponse.ok) {
        console.log(`🚀 Sent to n8n for Facebook publishing.`);
      } else {
        console.error(`❌ n8n webhook failed. Status: ${n8nResponse.status}`);
      }
    } catch (n8nError) {
      console.error("❌ Error reaching n8n. Is it running?", n8nError.message);
    }

    res.json({ success: true, content: updatedContent });
  } catch (error) {
    console.error("Approval Error:", error);
    res.status(500).json({ error: "Failed to approve content" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
});