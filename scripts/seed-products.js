// Adds test products to your shop so you can try orders, stock, AI chat and comments.
//
//   node scripts/seed-products.js            -> adds to the first user's workspace
//   node scripts/seed-products.js org_123    -> adds to this workspace id
//
// Running it twice is safe: products whose SKU already exists are skipped.
const mongoose = require("mongoose");
const { connectDB } = require("../src/db");
const { Product, StockMovement, User } = require("../src/models");
const { newId } = require("../src/models/_base");

// variants: [name, stock, price (null = product price)]
const PRODUCTS = [
  {
    name: "Cotton Panjabi", nameBn: "কটন পাঞ্জাবি", sku: "PJ-01", category: "Men", price: 1450, costPrice: 900,
    description: "100% cotton, summer friendly. Colours: white, sky blue.",
    variants: [["M", 12], ["L", 8], ["XL", 3], ["XXL", 0, 1550]], // XL = low stock, XXL = out of stock
  },
  {
    name: "Three Piece (Lawn)", nameBn: "থ্রি পিস", sku: "TP-01", category: "Women", price: 1850, costPrice: 1200,
    description: "Unstitched lawn three piece, orna included.",
    variants: [["Red", 10], ["Green", 6], ["Blue", 4]],
  },
  {
    name: "Jamdani Saree", nameBn: "জামদানি শাড়ি", sku: "SR-01", category: "Women", price: 4500, costPrice: 3200,
    description: "Handwoven jamdani, 12 hand, with blouse piece.",
    variants: [["Default", 5]],
  },
  {
    name: "Drop Shoulder T-Shirt", nameBn: "ড্রপ শোল্ডার টি-শার্ট", sku: "TS-01", category: "Men", price: 450, costPrice: 250,
    description: "180 GSM cotton. Size chart: M 40\", L 42\", XL 44\" chest.",
    variants: [["M / Black", 20], ["L / Black", 15], ["M / White", 10], ["L / White", 2]],
  },
  {
    name: "Jersey Hijab", nameBn: "জার্সি হিজাব", sku: "HJ-01", category: "Women", price: 350, costPrice: 180,
    variants: [["Black", 30], ["Maroon", 12], ["Navy", 9]],
  },
  {
    name: "Casual Sneakers", nameBn: "ক্যাজুয়াল স্নিকার্স", sku: "SN-01", category: "Shoes", price: 2200, costPrice: 1500,
    variants: [["40", 4], ["41", 6], ["42", 5], ["43", 1]],
  },
  {
    name: "Sundarban Honey 500g", nameBn: "সুন্দরবনের মধু ৫০০ গ্রাম", sku: "HN-500", category: "Food", price: 650, costPrice: 420,
    description: "Pure khalisha honey from the Sundarbans.",
    variants: [["Default", 40]],
  },
  {
    name: "Mustard Oil 1L", nameBn: "সরিষার তেল ১ লিটার", sku: "OIL-1L", category: "Food", price: 320, costPrice: 230,
    description: "Ghani-pressed mustard oil.",
    variants: [["1 Litre", 25], ["5 Litre", 6, 1500]],
  },
];

async function pickOrg() {
  if (process.argv[2]) return process.argv[2];
  const user = await User.findOne().sort({ createdAt: 1 }).lean();
  if (!user?.organizationId) throw new Error("No user found. Sign up in the app first, or pass the workspace id.");
  return user.organizationId;
}

async function main() {
  await connectDB();
  const org = await pickOrg();
  let added = 0;

  for (const p of PRODUCTS) {
    if (await Product.exists({ organizationId: org, sku: p.sku })) {
      console.log(`skip  ${p.name} (SKU ${p.sku} already exists)`);
      continue;
    }
    const variants = p.variants.map(([name, qty, price = null]) => ({
      _id: newId(), name, sku: `${p.sku}-${name.replace(/\W+/g, "")}`, price, onHand: qty, reserved: 0, available: qty,
    }));
    const product = await Product.create({ ...p, organizationId: org, variants });
    for (const v of variants.filter((x) => x.onHand)) {
      await StockMovement.create({
        organizationId: org, productId: product._id, variantId: v._id,
        label: `${p.name} · ${v.name}`, onHandChange: v.onHand, reason: "initial", note: "test data",
      });
    }
    added++;
    console.log(`added ${p.name}`);
  }

  console.log(`\nDone: ${added} products added to workspace ${org}`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error("Seed failed:", e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
