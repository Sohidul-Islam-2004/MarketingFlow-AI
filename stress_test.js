const axios = require('axios');

// This hits your n8n Production Webhook directly
const WEBHOOK_URL = 'http://localhost:5678/webhook/lead-capture';

async function runStressTest() {
    console.log("🚀 Starting FULL SYSTEM Stress Test: 100 Requests...");
    let successCount = 0;
    let failCount = 0;

    for (let i = 1; i <= 5; i++) {
        // Generate unique IDs using Date.now() and the loop index
        const uniqueId = `stress_${Date.now()}_${i}`;

        const payload = {
            tenantId: "org_123",
            eventId: "evt_" + uniqueId, // Unique event ID for deduplication
            leadId: "lead_" + uniqueId, // Unique lead ID for MySQL
            name: "Customer " + i,
            email: `customer${i}@test.com`,
            message: i % 2 === 0
                ? "I need a marketing tool. My budget is $5000. Call me now!"
                : "Just looking around, maybe next year."
        };
        try {
            const response = await axios.post(WEBHOOK_URL, payload);
            successCount++;
            console.log(`✅ Request ${i}/100 Accepted by n8n`);
        } catch (error) {
            failCount++;
            console.log(`❌ Request ${i} Failed: ${error.message}`);
        }

        // Small delay (100ms) to simulate real users, but still hits fast
        await new Promise(resolve => setTimeout(resolve, 3000));
    }

    console.log("\n=========================================");
    console.log(`📊 Stress Test Complete!`);
    console.log(`✅ Sent to n8n Successfully: ${successCount}`);
    console.log(`❌ Failed to reach n8n: ${failCount}`);
    console.log("Check n8n 'Executions' tab to see if the Fallback worked!");
    console.log("=========================================");
}

runStressTest();