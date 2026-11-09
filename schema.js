const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const Mixed = Schema.Types.Mixed;

const genId = () => new mongoose.Types.ObjectId().toString();

const jsonOptions = {
  versionKey: false,
  virtuals: false,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    return ret;
  },
};

const baseOpts = (extra = {}) => ({
  timestamps: { createdAt: true, updatedAt: false },
  versionKey: false,
  toJSON: jsonOptions,
  ...extra,
});
const withUpdates = { timestamps: true }; // createdAt + updatedAt

/* ============ 1. CORE ============ */
const marketingSettingsSchema = new Schema(
  {
    requireApproval: { type: Boolean, default: true }, // content must be approved before publishing
    creativeApproval: { type: Boolean, default: false }, // uploaded/AI media must be approved before use
    // recommend = AI only suggests | approval = changes need approval | guardrailed = small bounded budget changes auto-apply
    optimizationMode: { type: String, default: "recommend" },
    maxBudgetDeltaPct: { type: Number, default: 20 }, // guardrail: max % budget change per step
    maxDailyBudget: { type: Number, default: 0 }, // guardrail: 0 = no cap (account currency, major units)
    guardrailAllowlist: { type: [String], default: [] }, // Meta campaign ids allowed for guardrailed automation
    salesTeam: { type: [{ name: String, email: String, active: { type: Boolean, default: true } }], default: [] },
    rrIndex: { type: Number, default: 0 }, // round-robin pointer for lead assignment
    leadCategories: {
      type: [String],
      default: ["Product inquiry", "Service inquiry", "Wholesale / B2B", "Support", "Other"],
    },
    timezone: { type: String, default: "Asia/Dhaka" },
  },
  { _id: false }
);

const organizationSchema = new Schema(
  {
    _id: { type: String, default: genId },
    name: { type: String, required: true },
    plan: { type: String, default: "free" }, // free | pro | business
    planStatus: { type: String, default: "active" },
    planRenewsAt: { type: Date, default: null },
    marketingSettings: { type: marketingSettingsSchema, default: () => ({}) },
    metaBusinesses: { type: [{ id: String, name: String }], default: [] },
  },
  baseOpts()
);

// Atomic counters (used for order numbers)
const counterSchema = new Schema(
  { _id: { type: String }, seq: { type: Number, default: 0 } },
  { versionKey: false }
);

/* ============ 2. CRM & LEADS ============ */
const leadNoteSchema = new Schema(
  { text: String, by: { type: String, default: "system" }, at: { type: Date, default: Date.now } },
  { _id: true }
);

const leadSchema = new Schema(
  {
    _id: { type: String, default: genId }, // n8n can still send its own leadId
    organizationId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    email: { type: String, default: null },
    phone: { type: String, default: null },
    message: { type: String, default: null },
    aiScore: { type: Number, default: 0 },
    aiStatus: { type: String, default: "Cold" }, // Hot | Warm | Cold
    aiReason: { type: String, default: null },
    qualified: { type: Boolean, default: false },
    category: { type: String, default: "Other" },
    // manual | facebook_lead_ad | instagram_dm | n8n | comment | website
    source: { type: String, default: "manual" },
    externalId: { type: String, default: null }, // leadgen_id / IG sender id (dedup)
    formId: { type: String, default: null },
    pageId: { type: String, default: null },
    adId: { type: String, default: null },
    adsetId: { type: String, default: null },
    campaignId: { type: String, default: null },
    campaignName: { type: String, default: null },
    fields: { type: Mixed, default: {} }, // raw lead form answers
    stage: { type: String, default: "new" }, // new | contacted | qualified | proposal | won | lost
    assignedTo: { type: String, default: null },
    followUpAt: { type: Date, default: null },
    followUpNotified: { type: Boolean, default: false },
    notes: { type: [leadNoteSchema], default: [] },
    value: { type: Number, default: 0 }, // deal value when won
    convertedAt: { type: Date, default: null },
    orderId: { type: String, default: null },
    duplicateCount: { type: Number, default: 0 },
  },
  baseOpts(withUpdates)
);
leadSchema.index({ organizationId: 1, aiStatus: 1 });
leadSchema.index({ organizationId: 1, stage: 1, updatedAt: -1 });
leadSchema.index({ organizationId: 1, email: 1 });
leadSchema.index({ organizationId: 1, phone: 1 });
leadSchema.index({ organizationId: 1, externalId: 1 });
leadSchema.index({ organizationId: 1, campaignId: 1 });

const taskSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true, index: true },
    leadId: { type: String, default: null, index: true },
    title: { type: String, required: true },
    priority: { type: String, default: "High" },
    status: { type: String, default: "Pending" },
  },
  baseOpts()
);
taskSchema.index({ organizationId: 1, status: 1 });

/* ============ 3. CONTENT & MARKETING ============ */

// 3.1 Brand workspace (multiple brands, agency clients, brand voice, colours, approved facts)
const brandSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    clientName: { type: String, default: null }, // agency client this brand belongs to
    isDefault: { type: Boolean, default: false },
    industry: { type: String, default: "" },
    description: { type: String, default: "" },
    website: { type: String, default: "" },
    tone: { type: String, default: "friendly" },
    voice: { type: String, default: "" }, // free-text voice guide
    audience: { type: String, default: "" },
    pillars: { type: [{ name: String, description: String }], default: [] },
    offerings: { type: String, default: "" }, // products / services summary
    facts: { type: [String], default: [] }, // approved facts AI may use (prices, delivery, policies)
    prohibited: { type: [String], default: [] }, // claims / words AI must never use
    hashtags: { type: [String], default: [] },
    languages: { type: [String], default: ["bn", "en"] },
    defaultCta: { type: String, default: "" },
    colors: {
      primary: { type: String, default: "#0d1b2a" },
      secondary: { type: String, default: "#b8f03a" },
      accent: { type: String, default: "#ffffff" },
    },
    logoUrl: { type: String, default: null },
  },
  baseOpts(withUpdates)
);

// 3.2 Content items (drafts, approvals, versions, scheduling, publishing results)
const contentVariantSchema = new Schema(
  {
    platform: { type: String, required: true },
    caption: { type: String, required: true },
  },
  { _id: true }
);

const publishTargetSchema = new Schema(
  {
    accountId: { type: String, required: true }, // SocialAccount._id
    platform: { type: String, required: true }, // Facebook | Instagram
    accountName: String,
    status: { type: String, default: "pending" }, // pending | processing | published | failed
    providerPostId: { type: String, default: null },
    creationId: { type: String, default: null }, // IG container id (reused on retry)
    childIds: { type: [String], default: [] },
    permalink: { type: String, default: null },
    error: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    publishedAt: { type: Date, default: null },
    metrics: { type: Mixed, default: {} }, // reach, impressions, likes, comments, shares, saves, clicks, views
    metricsAt: { type: Date, default: null },
  },
  { _id: true }
);

const contentVersionSchema = new Schema(
  {
    body: String,
    headline: String,
    hashtags: [String],
    cta: String,
    variants: [{ platform: String, caption: String }],
    by: { type: String, default: "system" },
    note: { type: String, default: "" },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const contentItemSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true, index: true },
    brandId: { type: String, default: null, index: true },
    planId: { type: String, default: null },
    ownerId: { type: String, default: "system" },
    title: { type: String, required: true },
    body: { type: String, required: true },
    // post | reel | story | carousel | ad_copy | video_script | reel_script | story_script | storyboard | ...
    type: { type: String, default: "post" },
    format: { type: String, default: "post" }, // publishing format: post | reel | story
    pillar: { type: String, default: null },
    headline: { type: String, default: null },
    cta: { type: String, default: null },
    hashtags: { type: [String], default: [] },
    // Draft | In Review | Approved | Rejected | Scheduled | Publishing | Published | Partially Published | Failed
    status: { type: String, default: "Draft" },
    language: { type: String, default: "en" },
    variants: { type: [contentVariantSchema], default: [] }, // platform-specific captions
    mediaIds: { type: [String], default: [] }, // MediaAsset ids
    link: { type: String, default: null },
    targets: { type: [publishTargetSchema], default: [] },
    scheduledAt: { type: Date, default: null },
    publishedAt: { type: Date, default: null },
    nextAttemptAt: { type: Date, default: null },
    lockUntil: { type: Date, default: null },
    lastError: { type: String, default: null },
    approvals: {
      type: [{ action: String, by: String, comment: String, at: { type: Date, default: Date.now } }],
      default: [],
    },
    versions: { type: [contentVersionSchema], default: [] },
  },
  baseOpts(withUpdates)
);
contentItemSchema.index({ organizationId: 1, status: 1 });
contentItemSchema.index({ organizationId: 1, scheduledAt: 1 });
contentItemSchema.index({ status: 1, scheduledAt: 1, nextAttemptAt: 1 });

// 3.3 Strategy, plans, audience analysis, research (AI output saved for reuse)
const planItemSchema = new Schema(
  {
    date: Date,
    platform: String,
    format: String,
    pillar: String,
    topic: String,
    angle: String,
    caption: String,
    cta: String,
    contentItemId: { type: String, default: null },
  },
  { _id: true }
);

const contentPlanSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true, index: true },
    brandId: { type: String, default: null },
    // strategy | monthly | weekly | campaign | audience | research
    kind: { type: String, required: true },
    title: { type: String, required: true },
    input: { type: Mixed, default: {} },
    data: { type: Mixed, default: {} }, // structured AI output
    items: { type: [planItemSchema], default: [] }, // calendar ideas (monthly/weekly/campaign)
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
  },
  baseOpts(withUpdates)
);
contentPlanSchema.index({ organizationId: 1, kind: 1, createdAt: -1 });

// 3.4 Media & creative
const mediaAssetSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true, index: true },
    brandId: { type: String, default: null },
    name: { type: String, required: true },
    kind: { type: String, default: "image" }, // image | video
    mimeType: String,
    size: Number,
    width: Number,
    height: Number,
    file: String, // file name inside /uploads
    url: { type: String, required: true }, // served path, e.g. /uploads/abc.jpg
    source: { type: String, default: "upload" }, // upload | ai | template | resize | url
    prompt: { type: String, default: null },
    parentId: { type: String, default: null }, // resized/converted from
    tags: { type: [String], default: [] },
    status: { type: String, default: "approved" }, // pending | approved | rejected
    reviewNote: { type: String, default: null },
  },
  baseOpts(withUpdates)
);
mediaAssetSchema.index({ organizationId: 1, createdAt: -1 });

const creativeTemplateSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true, index: true },
    brandId: { type: String, default: null },
    name: { type: String, required: true },
    format: { type: String, default: "1:1" },
    layout: { type: Mixed, default: {} }, // colours, alignment, sizes, text defaults (rendered in the browser)
  },
  baseOpts(withUpdates)
);

// 3.5 Meta Ads: synced structure + daily insights + breakdowns
const adEntitySchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true, index: true },
    adAccountId: { type: String, required: true }, // act_123
    level: { type: String, required: true }, // campaign | adset | ad
    metaId: { type: String, required: true },
    parentId: { type: String, default: null }, // campaign id for adset, adset id for ad
    campaignId: { type: String, default: null },
    name: String,
    objective: String,
    status: String,
    effectiveStatus: String,
    dailyBudget: { type: Number, default: null }, // major currency units
    lifetimeBudget: { type: Number, default: null },
    optimizationGoal: String,
    startTime: Date,
    stopTime: Date,
    creative: { type: Mixed, default: null },
    targeting: { type: Mixed, default: null },
    syncedAt: Date,
  },
  baseOpts(withUpdates)
);
adEntitySchema.index({ organizationId: 1, metaId: 1 }, { unique: true });
adEntitySchema.index({ organizationId: 1, adAccountId: 1, level: 1 });

const adInsightSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true },
    adAccountId: { type: String, required: true },
    date: { type: String, required: true }, // YYYY-MM-DD (ad account timezone)
    adId: { type: String, required: true },
    adsetId: String,
    campaignId: String,
    spend: { type: Number, default: 0 },
    impressions: { type: Number, default: 0 },
    reach: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 }, // all clicks
    linkClicks: { type: Number, default: 0 },
    frequency: { type: Number, default: 0 },
    leads: { type: Number, default: 0 },
    purchases: { type: Number, default: 0 },
    purchaseValue: { type: Number, default: 0 },
  },
  { versionKey: false, toJSON: jsonOptions }
);
adInsightSchema.index({ organizationId: 1, adId: 1, date: 1 }, { unique: true });
adInsightSchema.index({ organizationId: 1, adAccountId: 1, date: 1 });
adInsightSchema.index({ organizationId: 1, campaignId: 1, date: 1 });

const adBreakdownSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true },
    adAccountId: { type: String, required: true },
    kind: { type: String, required: true }, // placement | age_gender | region
    campaignId: String,
    key: String, // e.g. "facebook · feed" or "25-34 · female"
    metrics: { type: Mixed, default: {} },
    range: String,
    syncedAt: Date,
  },
  { versionKey: false, toJSON: jsonOptions }
);
adBreakdownSchema.index({ organizationId: 1, adAccountId: 1, kind: 1 });

// Local campaign drafts (approval workflow before anything is created in Meta)
const campaignDraftSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true, index: true },
    brandId: { type: String, default: null },
    adAccountId: { type: String, required: true },
    name: { type: String, required: true },
    objective: { type: String, default: "OUTCOME_TRAFFIC" },
    specialAdCategories: { type: [String], default: [] },
    dailyBudget: { type: Number, required: true }, // major units
    startTime: Date,
    endTime: Date,
    targeting: {
      countries: { type: [String], default: ["BD"] },
      cities: { type: [{ key: String, name: String, radius: Number }], default: [] },
      ageMin: { type: Number, default: 18 },
      ageMax: { type: Number, default: 65 },
      genders: { type: [Number], default: [] }, // [] all, 1 male, 2 female
      customAudiences: { type: [{ id: String, name: String }], default: [] },
      excludedAudiences: { type: [{ id: String, name: String }], default: [] },
      advantageAudience: { type: Boolean, default: false },
    },
    placements: {
      automatic: { type: Boolean, default: true },
      publisherPlatforms: { type: [String], default: [] },
      facebookPositions: { type: [String], default: [] },
      instagramPositions: { type: [String], default: [] },
    },
    pixelId: { type: String, default: null },
    conversionEvent: { type: String, default: null }, // PURCHASE | LEAD | ...
    pageId: { type: String, required: true },
    leadFormId: { type: String, default: null },
    creative: {
      mediaId: String,
      primaryText: String,
      headline: String,
      description: String,
      cta: { type: String, default: "LEARN_MORE" },
      link: String,
      utm: { source: String, medium: String, campaign: String, content: String },
    },
    // draft | pending_approval | approved | rejected | created | active | error
    status: { type: String, default: "draft" },
    reviews: { type: [{ action: String, by: String, comment: String, at: { type: Date, default: Date.now } }], default: [] },
    meta: {
      campaignId: String,
      adsetId: String,
      creativeId: String,
      adId: String,
      imageHash: String,
    },
    lastError: { type: String, default: null },
  },
  baseOpts(withUpdates)
);

// Every live change to Meta (status / budget) goes through a change request (audit + approval)
const changeRequestSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true, index: true },
    adAccountId: String,
    level: String, // campaign | adset | ad
    metaId: String,
    entityName: String,
    type: { type: String, required: true }, // status | budget | activate_draft
    from: Mixed,
    to: Mixed,
    reason: String,
    source: { type: String, default: "user" }, // user | rule | ai | guardrail
    status: { type: String, default: "pending" }, // pending | approved | rejected | applied | failed
    requestedBy: { type: String, default: "system" },
    reviewedBy: String,
    reviewComment: String,
    appliedAt: Date,
    error: String,
    draftId: String,
  },
  baseOpts(withUpdates)
);
changeRequestSchema.index({ organizationId: 1, status: 1, createdAt: -1 });

const recommendationSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true, index: true },
    adAccountId: String,
    // underperforming | fatigue | high_spend | budget_increase | budget_decrease | copy | creative | audience | placement | general
    type: { type: String },
    level: String,
    metaId: String,
    entityName: String,
    title: String,
    detail: String,
    evidence: { type: Mixed, default: {} },
    severity: { type: String, default: "medium" }, // low | medium | high
    action: { type: Mixed, default: null }, // { type:'budget', to: 1200 } | { type:'status', to:'PAUSED' }
    source: { type: String, default: "rule" }, // rule | ai
    status: { type: String, default: "open" }, // open | dismissed | actioned
    key: String, // dedup key for rule-based items
  },
  baseOpts(withUpdates)
);
recommendationSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
recommendationSchema.index({ organizationId: 1, key: 1 });

const budgetPlanSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true, index: true },
    adAccountId: { type: String, default: "all" },
    clientName: { type: String, default: null },
    month: { type: String, required: true }, // YYYY-MM
    monthlyLimit: { type: Number, default: 0 },
    dailyLimit: { type: Number, default: 0 },
    alertAt: { type: [Number], default: [50, 80, 100] }, // % thresholds
    alertsSent: { type: [String], default: [] },
  },
  baseOpts(withUpdates)
);

const experimentSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true, index: true },
    brandId: { type: String, default: null },
    name: { type: String, required: true },
    type: { type: String, default: "copy" }, // copy | creative | cta | audience | landing_page
    hypothesis: { type: String, default: "" },
    metric: { type: String, default: "ctr" }, // ctr | cpc | cpl | cvr | roas | engagement_rate
    variants: {
      type: [
        {
          label: String,
          refType: { type: String, default: "ad" }, // ad | content
          refId: String,
          description: String,
          results: { type: Mixed, default: {} },
        },
      ],
      default: [],
    },
    status: { type: String, default: "draft" }, // draft | running | completed
    startedAt: Date,
    endedAt: Date,
    winner: { type: String, default: null }, // variant label
    confidence: { type: Number, default: null },
    aiNotes: { type: String, default: null },
  },
  baseOpts(withUpdates)
);

// 3.6 Organic analytics: daily account metrics + follower snapshots
const accountInsightSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true },
    accountId: { type: String, required: true }, // SocialAccount._id
    platform: String,
    date: { type: String, required: true }, // YYYY-MM-DD
    metrics: { type: Mixed, default: {} },
  },
  { versionKey: false, toJSON: jsonOptions }
);
accountInsightSchema.index({ organizationId: 1, accountId: 1, date: 1 }, { unique: true });

// 3.7 Competitor & market intelligence (public data only)
const competitorSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true, index: true },
    brandId: { type: String, default: null },
    name: { type: String, required: true },
    igUsername: { type: String, default: null },
    facebookUrl: { type: String, default: null },
    website: { type: String, default: null },
    notes: {
      type: [{ type: { type: String, default: "note" }, text: String, at: { type: Date, default: Date.now } }],
      default: [],
    },
    latest: { type: Mixed, default: null }, // last snapshot summary
    lastSnapshotAt: Date,
  },
  baseOpts(withUpdates)
);

const competitorSnapshotSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true },
    competitorId: { type: String, required: true, index: true },
    followers: Number,
    mediaCount: Number,
    postsPerWeek: Number,
    avgEngagement: Number,
    offers: { type: [String], default: [] },
    posts: { type: [Mixed], default: [] },
  },
  baseOpts()
);

/* ============ 4. COMMERCE ============ */
const productSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    sku: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    stock: { type: Number, default: 0, min: 0 },
    lowStockAt: { type: Number, default: 5 },
    category: { type: String, default: "General" },
    imageUrl: { type: String, default: null },
  },
  baseOpts(withUpdates)
);
productSchema.index({ organizationId: 1, sku: 1 }, { unique: true });

const orderItemSchema = new Schema(
  {
    productId: { type: String, default: null },
    name: { type: String, required: true },
    qty: { type: Number, default: 1, min: 1 },
    price: { type: Number, default: 0 },
  },
  { _id: false }
);

const orderSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true, index: true },
    orderNo: { type: String, required: true },
    customerName: { type: String, required: true },
    phone: { type: String, required: true, index: true },
    address: { type: String, required: true },
    items: { type: [orderItemSchema], default: [] },
    total: { type: Number, required: true, min: 0 },
    paymentMethod: { type: String, default: "COD" }, // COD | bKash | Nagad | Card
    paymentStatus: { type: String, default: "unpaid" }, // unpaid | paid
    channel: { type: String, default: "Manual" }, // Messenger AI | Facebook Comment | Lead Discovery | Manual
    isAI: { type: Boolean, default: false },
    // pending | confirmed | processing | shipped | delivered | cancelled | on_hold
    status: { type: String, default: "pending" },
    riskScore: { type: Number, default: 0 },
    riskReasons: { type: [String], default: [] },
    courier: {
      provider: { type: String, default: null },
      trackingId: { type: String, default: null },
      shippedAt: { type: Date, default: null },
    },
    deliveryFee: { type: Number, default: 0 },
    conversationId: { type: String, default: null },
    psid: { type: String, default: null },
    // Marketing attribution (campaign ROI / lead conversion)
    attribution: {
      source: { type: String, default: null }, // utm_source
      medium: { type: String, default: null },
      campaign: { type: String, default: null }, // utm_campaign or Meta campaign id
      content: { type: String, default: null },
      adId: { type: String, default: null },
      leadId: { type: String, default: null },
    },
  },
  baseOpts(withUpdates)
);
orderSchema.index({ organizationId: 1, orderNo: 1 }, { unique: true });
orderSchema.index({ organizationId: 1, createdAt: -1 });
orderSchema.index({ organizationId: 1, status: 1 });
orderSchema.index({ organizationId: 1, "attribution.campaign": 1 });

/* ============ 5. MESSENGER INBOX ============ */
const messageSchema = new Schema(
  {
    from: { type: String, enum: ["customer", "ai", "agent", "system"], required: true },
    text: { type: String, required: true },
    at: { type: Date, default: Date.now },
    by: { type: String, default: null }, // agent name
    mid: { type: String, default: null }, // Meta message id
    quickReplies: { type: [String], default: undefined }, // buttons shown under an AI message
    privateReply: { type: Boolean, default: undefined }, // AI reply to a comment
    fromComment: { type: Boolean, default: undefined }, // customer text came from a public comment
    error: { type: String, default: undefined }, // delivery error from Meta
  },
  { _id: true }
);

const conversationSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true, index: true },
    psid: { type: String, required: true }, // Facebook page-scoped user id / Instagram-scoped id
    customerName: { type: String, default: "Customer" },
    channel: { type: String, default: "Messenger" },
    status: { type: String, default: "open" }, // open | needs_review | closed
    unread: { type: Number, default: 0 },
    lastMessage: { type: String, default: "" },
    messages: { type: [messageSchema], default: [] },
    pageId: { type: String, default: null }, // Facebook Page that owns the chat (IG: linked Page)
    avatar: { type: String, default: null },
    aiPaused: { type: Boolean, default: false }, // human takeover
    handoffReason: { type: String, default: null },
    lastCustomerAt: { type: Date, default: null }, // Messenger 24-hour window starts here
    aiHandled: { type: Number, default: 0 }, // AI replies sent
    source: { type: Mixed, default: null }, // { type:'comment', commentId, postId, text }
    // { items:[{productId,name,variant,qty,price,stock}], name, phone, address, area:'inside'|'outside', status:'collecting'|'awaiting_confirm'|'placed' }
    orderDraft: { type: Mixed, default: () => ({ items: [], status: "collecting" }) },
    orderId: { type: String, default: null },
    orderNo: { type: String, default: null },
    leadId: { type: String, default: null },
  },
  baseOpts(withUpdates)
);
conversationSchema.index({ organizationId: 1, psid: 1 }, { unique: true });
conversationSchema.index({ organizationId: 1, status: 1, updatedAt: -1 });

/* ============ 6. FRAUD SHIELD ============ */
const blacklistSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true, index: true },
    phone: { type: String, required: true },
    reason: { type: String, default: "Blocked manually" },
  },
  baseOpts()
);
blacklistSchema.index({ organizationId: 1, phone: 1 }, { unique: true });

/* ============ 7. AI AGENT SETTINGS ============ */
const agentConfigSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true, unique: true },
    enabled: { type: Boolean, default: true },
    autoConfirm: { type: Boolean, default: true },
    tone: { type: String, default: "friendly" },
    escalateBelow: { type: Number, default: 60, min: 0, max: 100 },
    greeting: { type: String, default: "Hi! How can I help you today?" },
    deliveryInside: { type: Number, default: 80 }, // delivery fee inside Dhaka
    deliveryOutside: { type: Number, default: 130 },
    deliveryTime: { type: String, default: "24-48 hours inside Dhaka, 3-5 days outside" },
    paymentNote: { type: String, default: "" },
    knowledge: { type: String, default: "" }, // policies, FAQ, hours, location: the only facts the AI may use
    handoffMessage: { type: String, default: "Thanks! I'm connecting you with our team. They'll reply shortly 🙏" },
    commentAutoReply: { type: Boolean, default: true }, // private-reply to new post comments
    commentPrivateReply: { type: String, default: "Hi {name}! 👋 Thanks for your comment on our post. Tell me which product, size/colour and quantity you'd like and I'll get your order ready right here." },
    commentPublicReply: { type: String, default: "" }, // optional public reply, e.g. "Inbox করা হয়েছে ✅"
  },
  baseOpts(withUpdates)
);

/* ============ 8. AUTOMATION (Idempotency) ============ */
const webhookEventSchema = new Schema(
  {
    _id: { type: String, default: genId },
    provider: { type: String, required: true },
    externalEventId: { type: String, required: true, unique: true },
    tenantId: { type: String, required: true },
    processingStatus: { type: String, default: "pending" },
  },
  baseOpts({ timestamps: { createdAt: "receivedAt", updatedAt: false } })
);
webhookEventSchema.index({ tenantId: 1, processingStatus: 1 });

/* ============ 9. SOCIAL ACCOUNTS (Meta) ============ */
const socialAccountSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true, index: true },
    platform: { type: String, required: true }, // Facebook | Instagram | Meta Ads | LinkedIn
    accountName: { type: String, required: true },
    accountId: { type: String, required: true }, // page id | IG user id | act_123
    accessToken: { type: String, required: true, select: false }, // encrypted ("enc:v1:...")
    brandId: { type: String, default: null },
    clientName: { type: String, default: null }, // agency client
    pageId: { type: String, default: null }, // IG: linked Facebook Page id
    username: { type: String, default: null },
    pictureUrl: { type: String, default: null },
    tasks: { type: [String], default: [] }, // Page tasks the user granted (CREATE_CONTENT, ADVERTISE...)
    scopes: { type: [String], default: [] }, // granted permissions
    currency: { type: String, default: null }, // ad accounts
    timezone: { type: String, default: null },
    businessId: { type: String, default: null },
    businessName: { type: String, default: null },
    connectedVia: { type: String, default: "manual" }, // manual | oauth
    status: { type: String, default: "active" }, // active | expiring | expired | revoked | error
    healthNote: { type: String, default: null },
    tokenExpiresAt: { type: Date, default: null },
    lastCheckedAt: { type: Date, default: null },
    lastSyncedAt: { type: Date, default: null },
  },
  baseOpts(withUpdates)
);
socialAccountSchema.index({ organizationId: 1, platform: 1 });
socialAccountSchema.index({ organizationId: 1, platform: 1, accountId: 1 });
socialAccountSchema.index({ platform: 1, accountId: 1 }); // webhook lookup by page id

/* ============ 10. NOTIFICATIONS + AI USAGE ============ */
const notificationSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true },
    type: { type: String, default: "info" }, // publish_failed | budget | lead | follow_up | ads | token | info
    title: String,
    message: String,
    view: { type: String, default: null }, // dashboard view to open
    read: { type: Boolean, default: false },
  },
  baseOpts()
);
notificationSchema.index({ organizationId: 1, read: 1, createdAt: -1 });

const aiUsageSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true },
    task: String,
    model: String,
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    ok: { type: Boolean, default: true },
  },
  baseOpts()
);
aiUsageSchema.index({ organizationId: 1, createdAt: -1 });

/* ============ MODELS ============ */
const Organization = model("Organization", organizationSchema);
const Counter = model("Counter", counterSchema);
const Lead = model("Lead", leadSchema);
const Task = model("Task", taskSchema);
const Brand = model("Brand", brandSchema);
const ContentItem = model("ContentItem", contentItemSchema);
const ContentPlan = model("ContentPlan", contentPlanSchema);
const MediaAsset = model("MediaAsset", mediaAssetSchema);
const CreativeTemplate = model("CreativeTemplate", creativeTemplateSchema);
const AdEntity = model("AdEntity", adEntitySchema);
const AdInsight = model("AdInsight", adInsightSchema);
const AdBreakdown = model("AdBreakdown", adBreakdownSchema);
const CampaignDraft = model("CampaignDraft", campaignDraftSchema);
const ChangeRequest = model("ChangeRequest", changeRequestSchema);
const Recommendation = model("Recommendation", recommendationSchema);
const BudgetPlan = model("BudgetPlan", budgetPlanSchema);
const Experiment = model("Experiment", experimentSchema);
const AccountInsight = model("AccountInsight", accountInsightSchema);
const Competitor = model("Competitor", competitorSchema);
const CompetitorSnapshot = model("CompetitorSnapshot", competitorSnapshotSchema);
const Product = model("Product", productSchema);
const Order = model("Order", orderSchema);
const Conversation = model("Conversation", conversationSchema);
const Blacklist = model("Blacklist", blacklistSchema);
const AgentConfig = model("AgentConfig", agentConfigSchema);
const WebhookEvent = model("WebhookEvent", webhookEventSchema);
const SocialAccount = model("SocialAccount", socialAccountSchema);
const Notification = model("Notification", notificationSchema);
const AiUsage = model("AiUsage", aiUsageSchema);

async function nextOrderNo(orgId) {
  const c = await Counter.findOneAndUpdate(
    { _id: `order:${orgId}` },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return `ORD-${100000 + c.seq}`;
}

async function deleteOrganizationCascade(orgId) {
  const by = { organizationId: orgId };
  await Promise.all([
    Task.deleteMany(by),
    Lead.deleteMany(by),
    Brand.deleteMany(by),
    ContentItem.deleteMany(by),
    ContentPlan.deleteMany(by),
    MediaAsset.deleteMany(by),
    CreativeTemplate.deleteMany(by),
    AdEntity.deleteMany(by),
    AdInsight.deleteMany(by),
    AdBreakdown.deleteMany(by),
    CampaignDraft.deleteMany(by),
    ChangeRequest.deleteMany(by),
    Recommendation.deleteMany(by),
    BudgetPlan.deleteMany(by),
    Experiment.deleteMany(by),
    AccountInsight.deleteMany(by),
    Competitor.deleteMany(by),
    CompetitorSnapshot.deleteMany(by),
    Notification.deleteMany(by),
    AiUsage.deleteMany(by),
    SocialAccount.deleteMany(by),
    Product.deleteMany(by),
    Order.deleteMany(by),
    Conversation.deleteMany(by),
    Blacklist.deleteMany(by),
    AgentConfig.deleteMany(by),
    Counter.deleteOne({ _id: `order:${orgId}` }),
  ]);
  await Organization.deleteOne({ _id: orgId });
}

module.exports = {
  Organization,
  Counter,
  Lead,
  Task,
  Brand,
  ContentItem,
  ContentPlan,
  MediaAsset,
  CreativeTemplate,
  AdEntity,
  AdInsight,
  AdBreakdown,
  CampaignDraft,
  ChangeRequest,
  Recommendation,
  BudgetPlan,
  Experiment,
  AccountInsight,
  Competitor,
  CompetitorSnapshot,
  Product,
  Order,
  Conversation,
  Blacklist,
  AgentConfig,
  WebhookEvent,
  SocialAccount,
  Notification,
  AiUsage,
  nextOrderNo,
  deleteOrganizationCascade,
};