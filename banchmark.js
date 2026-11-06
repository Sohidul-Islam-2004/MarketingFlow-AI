// benchmark.js
const axios = require('axios');

// আপনার Groq API Key এখানে দিন
const GROQ_API_KEY = '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';

const testTopics = ["Summer Sale", "New Tech Gadgets", "Fitness Tips", "Investment Guide", "Travel Deals"];
const testLeads = [
    "I need a marketing tool, budget $5000",
    "Just looking around, maybe next year",
    "URGENT: Need this set up by tomorrow!",
    "What are your prices?",
    "We have a team of 50 people and need enterprise pricing."
];

async function runBenchmark() {
    console.log("🚀 Starting Benchmark: 100 Requests...");
    let totalTime = 0;
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < 100; i++) {
        const isLeadTest = i % 2 === 0;
        const prompt = isLeadTest
            ? `Score this lead 1-100: "${testLeads[Math.floor(Math.random() * testLeads.length)]}"`
            : `Write an Instagram post about: "${testTopics[Math.floor(Math.random() * testTopics.length)]}"`;

        const startTime = Date.now();
        try {
            // Notice how the URL, the DATA, and the HEADERS are all inside the same axios.post()
            const response = await axios.post(
                'https://api.groq.com/openai/v1/chat/completions', // 1. The URL
                {
                    model: "openai/gpt-oss-20b",             // 2. The Body/Data
                    messages: [{ role: "user", content: prompt }]
                },
                {
                    headers: {                                     // 3. The Headers/Config
                        'Authorization': `Bearer ${GROQ_API_KEY}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            const endTime = Date.now();
            const latency = endTime - startTime;
            totalTime += latency;
            successCount++;

            console.log(`✅ Request ${i + 1}/100 | Latency: ${latency}ms | Module: ${isLeadTest ? 'Lead' : 'Content'}`);

        } catch (error) {
            failCount++;
            // This will print the actual error message from Groq (like "Invalid API Key" or "Rate Limit")
            console.log(`❌ Request ${i + 1} Failed: ${error.response ? error.response.data.error.message : error.message}`);
        }


    await new Promise(resolve => setTimeout(resolve, 1000));
}

console.log("\n=========================================");
console.log(`📊 Benchmark Complete!`);
console.log(`✅ Successful: ${successCount}`);
console.log(`❌ Failed: ${failCount}`);
console.log(`⏱️ Average Response Time: ${(totalTime / successCount).toFixed(2)} ms`);
console.log("=========================================");
}

runBenchmark();