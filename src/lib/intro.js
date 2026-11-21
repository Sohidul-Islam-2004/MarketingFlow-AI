// The message the AI sends once at the start of a new chat: that an AI is answering, how to ask it
// (so it can answer and take the order), and how to reach a person ("মানুষ" hands the chat to the shop).
// {shop} = the shop's name, {product} = one of the shop's real products (so the examples fit the shop).
const DEFAULT_INTRO = `আসসালামু আলাইকুম! আমি {shop}-এর AI সহকারী 🤖 যেকোনো সময় উত্তর দিই।

আমাকে এভাবে জিজ্ঞেস করতে পারেন:
💰 "{product}-এর দাম কত?"
📏 "কী কী সাইজ / কালার আছে?"
📷 "{product}-এর ছবি দেখান"
🛒 অর্ডার করতে: "{product} অর্ডার করব" লিখুন, তারপর আমি নাম, ফোন আর ঠিকানা জেনে নেব।

মানুষের সাথে কথা বলতে চাইলে শুধু "মানুষ" লিখুন 🙏`;

const introText = (ai = {}) => String(ai.introText || "").trim() || DEFAULT_INTRO;
const fillIntro = (text, shopName, productName) => text
  .replace(/\{shop\}/g, shopName || "আমাদের দোকান")
  .replace(/\{product\}/g, productName || "প্রোডাক্টটি");

module.exports = { DEFAULT_INTRO, introText, fillIntro };
