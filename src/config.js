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

  // The first account that signs up takes over this workspace (keeps your old data)
  DEFAULT_TENANT: env.DEFAULT_TENANT || "org_123",

  // Public https address of this server (Cloudflare tunnel / your domain). Needed for Instagram media.
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
  },

  LEGAL: {
    BUSINESS_NAME: env.BUSINESS_NAME || "MarketingFlow AI",
    SUPPORT_EMAIL: env.SUPPORT_EMAIL || "support@example.com",
    BUSINESS_ADDRESS: env.BUSINESS_ADDRESS || "Dhaka, Bangladesh",
  },

  JOBS_ON: env.JOBS !== "off",
};
