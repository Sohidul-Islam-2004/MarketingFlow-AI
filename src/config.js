// Every setting from .env is read here, once. Other files import from this file.
require("dotenv").config();

const env = process.env;
const PORT = Number(env.PORT) || 3000;

module.exports = {
  PORT,
  DATABASE_URL: env.DATABASE_URL,
  // Your network's DNS sometimes can't resolve MongoDB Atlas "mongodb+srv" addresses.
  // Default: Google DNS. Set DNS_SERVERS=system to use your computer's DNS instead.
  DNS_SERVERS: env.DNS_SERVERS || "8.8.8.8,8.8.4.4",

  // Super Admin: these emails see the Admin menu (comma separated). Example: SUPER_ADMIN_EMAILS=you@gmail.com
  SUPER_ADMIN_EMAILS: String(env.SUPER_ADMIN_EMAILS || "").toLowerCase().split(",").map((e) => e.trim()).filter(Boolean),
  // Anyone can create an account only when this is "on". Otherwise the Super Admin creates accounts.
  // (The very first account can always be created, so you can make your own.)
  ALLOW_SIGNUP: env.ALLOW_SIGNUP === "on",
  // Shown on the login page under "Forgot password?" (your WhatsApp / phone / email)
  SUPPORT_CONTACT: env.SUPPORT_CONTACT || "",

  // The first account that signs up takes over this workspace (keeps your old data)
  DEFAULT_TENANT: env.DEFAULT_TENANT || "org_123",

  // Public https address of this server (Cloudflare tunnel / your domain). Needed for webhooks and photo/video posts.
  PUBLIC_BASE_URL: (env.PUBLIC_BASE_URL || "").replace(/\/$/, ""),

  // Encrypts Facebook tokens in the database. Never change it after Pages are connected.
  TOKEN_ENC_KEY: env.TOKEN_ENC_KEY || "",

  META: {
    APP_ID: env.FB_APP_ID,
    APP_SECRET: env.FB_APP_SECRET,
    REDIRECT_URI: env.FB_REDIRECT_URI || `http://localhost:${PORT}/auth/facebook/callback`,
    CONFIG_ID: env.FB_CONFIG_ID || "",
    GRAPH_VERSION: env.FB_GRAPH_VERSION || "v23.0",
    VERIFY_TOKEN: env.META_WEBHOOK_VERIFY_TOKEN || "",
  },

  AI: {
    BASE_URL: (env.AI_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, ""),
    API_KEY: env.AI_API_KEY || "",
    MODEL: env.AI_MODEL || "openai/gpt-oss-120b",
    // A model that looks at photos customers send (product photo, screenshot). Groq has none since July 2026,
    // so it can use another service, e.g. Google Gemini (free tier):
    //   AI_VISION_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai  AI_VISION_API_KEY=<Gemini key>  AI_VISION_MODEL=gemini-3.6-flash
    // Empty = the AI asks the customer which product it is.
    VISION_MODEL: /llama-4-scout/.test(env.AI_VISION_MODEL || "") ? "" : env.AI_VISION_MODEL || "",
    VISION_BASE_URL: (env.AI_VISION_BASE_URL || env.AI_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, ""),
    VISION_API_KEY: env.AI_VISION_API_KEY || env.AI_API_KEY || "",
    // Turns customers' voice messages into text (Groq: whisper-large-v3). Empty = the AI asks them to type.
    VOICE_MODEL: env.AI_VOICE_MODEL ?? (/groq\.com/.test(env.AI_BASE_URL || "https://api.groq.com") ? "whisper-large-v3" : ""),
    VOICE_LANGUAGE: env.AI_VOICE_LANGUAGE ?? "bn", // most customers speak Bangla; empty = guess the language
  },

  LEGAL: {
    BUSINESS_NAME: env.BUSINESS_NAME || "MarketingFlow AI",
    SUPPORT_EMAIL: env.SUPPORT_EMAIL || "support@example.com",
    BUSINESS_ADDRESS: env.BUSINESS_ADDRESS || "Dhaka, Bangladesh",
  },

  JOBS_ON: env.JOBS !== "off",
};
