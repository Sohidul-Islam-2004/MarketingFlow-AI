const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

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

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
  console.log(`Waiting for n8n webhooks...`);
});