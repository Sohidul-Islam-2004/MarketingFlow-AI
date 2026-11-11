// Bangladesh places: 64 districts, Dhaka areas, and delivery-zone matching.
// Each district row is [English name, Bangla name, other spellings...]
const DISTRICTS = [
  ["Dhaka", "ঢাকা", "dacca"], ["Faridpur", "ফরিদপুর"], ["Gazipur", "গাজীপুর", "gajipur"], ["Gopalganj", "গোপালগঞ্জ"], ["Kishoreganj", "কিশোরগঞ্জ", "kishorganj"],
  ["Madaripur", "মাদারীপুর"], ["Manikganj", "মানিকগঞ্জ"], ["Munshiganj", "মুন্সিগঞ্জ", "munsiganj"], ["Narayanganj", "নারায়ণগঞ্জ", "narayangonj", "narayangang"], ["Narsingdi", "নরসিংদী", "narsingdi", "norsingdi"],
  ["Rajbari", "রাজবাড়ী"], ["Shariatpur", "শরীয়তপুর"], ["Tangail", "টাঙ্গাইল"],
  ["Bandarban", "বান্দরবান"], ["Brahmanbaria", "ব্রাহ্মণবাড়িয়া", "b.baria", "bbaria"], ["Chandpur", "চাঁদপুর"], ["Chattogram", "চট্টগ্রাম", "chittagong", "ctg", "chattagram"], ["Cox's Bazar", "কক্সবাজার", "coxs bazar", "coxsbazar", "cox bazar"],
  ["Cumilla", "কুমিল্লা", "comilla"], ["Feni", "ফেনী"], ["Khagrachhari", "খাগড়াছড়ি", "khagrachari"], ["Lakshmipur", "লক্ষ্মীপুর", "laxmipur"], ["Noakhali", "নোয়াখালী"], ["Rangamati", "রাঙ্গামাটি"],
  ["Bogura", "বগুড়া", "bogra"], ["Joypurhat", "জয়পুরহাট", "jaipurhat"], ["Naogaon", "নওগাঁ"], ["Natore", "নাটোর"], ["Chapainawabganj", "চাঁপাইনবাবগঞ্জ", "chapai nawabganj", "chapai"], ["Pabna", "পাবনা"], ["Rajshahi", "রাজশাহী"], ["Sirajganj", "সিরাজগঞ্জ"],
  ["Bagerhat", "বাগেরহাট"], ["Chuadanga", "চুয়াডাঙ্গা"], ["Jashore", "যশোর", "jessore"], ["Jhenaidah", "ঝিনাইদহ", "jhenaidaha"], ["Khulna", "খুলনা"], ["Kushtia", "কুষ্টিয়া"], ["Magura", "মাগুরা"], ["Meherpur", "মেহেরপুর"], ["Narail", "নড়াইল"], ["Satkhira", "সাতক্ষীরা"],
  ["Barguna", "বরগুনা"], ["Barishal", "বরিশাল", "barisal"], ["Bhola", "ভোলা"], ["Jhalokati", "ঝালকাঠি", "jhalakathi", "jhalokathi"], ["Patuakhali", "পটুয়াখালী"], ["Pirojpur", "পিরোজপুর"],
  ["Habiganj", "হবিগঞ্জ"], ["Moulvibazar", "মৌলভীবাজার", "maulvibazar", "moulvi bazar"], ["Sunamganj", "সুনামগঞ্জ"], ["Sylhet", "সিলেট"],
  ["Dinajpur", "দিনাজপুর"], ["Gaibandha", "গাইবান্ধা"], ["Kurigram", "কুড়িগ্রাম"], ["Lalmonirhat", "লালমনিরহাট"], ["Nilphamari", "নীলফামারী"], ["Panchagarh", "পঞ্চগড়"], ["Rangpur", "রংপুর"], ["Thakurgaon", "ঠাকুরগাঁও"],
  ["Jamalpur", "জামালপুর"], ["Mymensingh", "ময়মনসিংহ", "mymensing"], ["Netrokona", "নেত্রকোনা", "netrakona"], ["Sherpur", "শেরপুর"],
];
const DISTRICT_NAMES = DISTRICTS.map((d) => d[0]);
const DHAKA_CITY_AREAS = ["dhanmondi", "gulshan", "banani", "mirpur", "uttara", "mohammadpur", "badda", "rampura", "motijheel", "khilgaon", "bashundhara", "baridhara", "tejgaon", "farmgate", "mohakhali", "malibagh", "moghbazar", "magbazar", "shantinagar", "lalbagh", "old dhaka", "puran dhaka", "jatrabari", "demra", "shyamoli", "kallyanpur", "adabor", "cantonment", "khilkhet", "nikunja", "kuril", "wari", "sutrapur", "kotwali", "chawkbazar", "hazaribagh", "kamrangirchar", "shahbag", "ramna", "paltan", "segunbagicha", "azimpur", "new market", "kalabagan", "panthapath", "kawran bazar", "karwan bazar", "banasree", "aftabnagar", "mugda", "basabo", "sabujbagh", "shyampur", "kadamtali", "turag", "dakshinkhan", "uttarkhan", "pallabi", "kafrul", "agargaon", "sher-e-bangla nagar", "bangshal", "gendaria", "lalmatia", "jigatola", "elephant road", "bailey road", "kakrail", "dhaka cantonment",
  "ধানমন্ডি", "গুলশান", "বনানী", "মিরপুর", "উত্তরা", "মোহাম্মদপুর", "বাড্ডা", "রামপুরা", "মতিঝিল", "খিলগাঁও", "বসুন্ধরা", "যাত্রাবাড়ী", "মালিবাগ", "মগবাজার", "তেজগাঁও", "মহাখালী", "ফার্মগেট", "শ্যামলী", "লালবাগ", "আজিমপুর", "বাসাবো", "পল্লবী", "খিলক্ষেত"];
const DHAKA_SUBURB_AREAS = ["savar", "ashulia", "keraniganj", "tongi", "dhamrai", "nawabganj dhaka", "dohar", "সাভার", "আশুলিয়া", "কেরানীগঞ্জ", "টঙ্গী", "ধামরাই"];

const DEFAULT_ZONES = [
  { name: "Inside Dhaka", fee: 80, districts: ["Dhaka"], areas: DHAKA_CITY_AREAS, isDefault: false, freeOver: 0 },
  { name: "Dhaka suburbs", fee: 100, districts: ["Gazipur", "Narayanganj"], areas: DHAKA_SUBURB_AREAS, isDefault: false, freeOver: 0 },
  { name: "Outside Dhaka", fee: 130, districts: [], areas: [], isDefault: true, freeOver: 0 },
];

// "House #5, Road-2" -> " house 5 road 2 " (lowercase words with spaces around, for matching)
const normalizeText = (s) => ` ${String(s || "").toLowerCase().replace(/[’'`]/g, "").replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim()} `;
const containsWord = (text, word) => text.includes(normalizeText(word));

// Short form of an address, used to spot many orders going to the same place
const addressKey = (address) =>
  normalizeText(address).replace(/\b(house|home|road|rd|flat|floor|lane|block|sector|holding|no)\b/g, " ").replace(/\s+/g, " ").trim().slice(0, 140) || null;

// "chittagong" -> "Chattogram". Returns null if it isn't a district name.
function canonicalDistrict(name) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return null;
  const row = DISTRICTS.find((names) => names.some((x) => x.toLowerCase() === n));
  return row ? row[0] : null;
}

// Finds the district mentioned anywhere in an address
function findDistrict(address) {
  const text = normalizeText(address);
  // longer names first so "chapai nawabganj" wins over "nawabganj"
  const aliases = DISTRICTS.flatMap((names) => names.map((alias) => [names[0], alias])).sort((a, b) => b[1].length - a[1].length);
  const hit = aliases.find(([, alias]) => containsWord(text, alias));
  if (hit) return hit[0];
  if (containsWord(text, "tongi") || containsWord(text, "টঙ্গী")) return "Gazipur";
  if ([...DHAKA_CITY_AREAS, ...DHAKA_SUBURB_AREAS].some((a) => containsWord(text, a))) return "Dhaka";
  return null;
}

// Address + district -> { zone, fee, district, matched }
// Area names win (e.g. "Savar" is in Dhaka district but is a suburb), then district, then the default zone.
function findZone(zones, { address, district }) {
  const list = zones && zones.length ? zones : DEFAULT_ZONES;
  const text = normalizeText(`${address || ""} ${district || ""}`);
  const dist = canonicalDistrict(district) || findDistrict(address);
  const byArea = list.find((z) => (z.areas || []).some((a) => containsWord(text, a)));
  const byDistrict = dist ? list.find((z) => (z.districts || []).some((d) => d.toLowerCase() === dist.toLowerCase())) : null;
  const fallback = list.find((z) => z.isDefault) || list[list.length - 1];

  let zone = fallback, matched = dist ? "district" : "default";
  const areaFitsDistrict = byArea && (!dist || dist === "Dhaka" || (byArea.districts || []).includes(dist));
  if (areaFitsDistrict) { zone = byArea; matched = "area"; }
  else if (byDistrict) { zone = byDistrict; matched = "district"; }

  return { zone: zone.name, fee: Number(zone.fee) || 0, freeOver: Number(zone.freeOver) || 0, district: dist, matched };
}

module.exports = { DEFAULT_ZONES, DISTRICT_NAMES, normalizeText, addressKey, canonicalDistrict, findDistrict, findZone };
