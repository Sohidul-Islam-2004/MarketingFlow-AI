const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());
// Serve the frontend dashboard
app.use(express.static(__dirname));
// ==========================================
// ENDPOINT 1: Deduplication Check (Idempotency)
// ==========================================
app.post('/api/leads/check-duplicate', async (req, res) => {
  const { tenantId, eventId } = req.body;

  try {
    // Look for the event ID in the database
    const existingEvent = await prisma.webhookEvent.findUnique({
      where: { eventId: eventId }
    });

    if (existingEvent) {
      // If it exists, tell n8n to stop
      return res.json({ isDuplicate: true });
    }

    // If it's new, save the event ID so the next attempt is blocked
    await prisma.webhookEvent.create({
      data: {
        tenantId: tenantId,
        eventId: eventId
      }
    });

    // Tell n8n to continue
    return res.json({ isDuplicate: false });

  } catch (error) {
    console.error("Dedupe Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ==========================================
// ENDPOINT 2: Save Lead (With AI Score)
// ==========================================
app.post('/api/leads/create', async (req, res) => {
  const { tenantId, leadId, name, email, aiScore, aiStatus, aiReason } = req.body;

  try {
    const newLead = await prisma.lead.create({
      data: {
        id: leadId, // We use the ID provided by n8n for consistency
        tenantId: tenantId,
        name: name,
        email: email,
        aiScore: parseInt(aiScore),
        aiStatus: aiStatus,
        aiReason: aiReason
      }
    });

    console.log(`✅ Lead Saved: ${name} | Score: ${aiScore} (${aiStatus})`);
    res.json({ success: true, lead: newLead });

  } catch (error) {
    console.error("Lead Save Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ==========================================
// ENDPOINT 3: Create Task
// ==========================================
app.post('/api/tasks/create', async (req, res) => {
  const { tenantId, leadId, title, priority } = req.body;

  try {
    const newTask = await prisma.task.create({
      data: {
        tenantId: tenantId,
        leadId: leadId,
        title: title,
        priority: priority
      }
    });

    console.log(`📋 Task Created for Lead: ${leadId}`);
    res.json({ success: true, task: newTask });

  } catch (error) {
    console.error("Task Save Error:", error);
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
      data: {
        tenantId: tenantId,
        platform: platform,
        topic: topic,
        generatedText: generatedText,
        status: "Draft"
      }
    });

    console.log(`✍️ Content Created for ${platform}: ${topic}`);
    res.json({ success: true, content: newContent });

  } catch (error) {
    console.error("Content Save Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});





// ==========================================
// ENDPOINT 5: Get all Leads
// ==========================================
app.get('/api/leads', async (req, res) => {
  try {
    const leads = await prisma.lead.findMany({
      orderBy: { createdAt: 'desc' } // Newest first
    });
    res.json(leads);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch leads" });
  }
});

// ==========================================
// ENDPOINT 6: Get all Content
// ==========================================
app.get('/api/content', async (req, res) => {
  try {
    const content = await prisma.content.findMany({
      orderBy: { createdAt: 'desc' }
    });
    res.json(content);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch content" });
  }
});














// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
  console.log(`Waiting for n8n webhooks...`);
});