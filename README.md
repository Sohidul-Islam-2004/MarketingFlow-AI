# MarketingFlow AI v2

An AI sales inbox, comment auto-replies, orders, stock and Facebook/Instagram posting for Bangladeshi online shops.
Built with Node.js, Express, MongoDB and plain HTML/CSS/JS. There is no build step.

## Run it

```bash
npm install
cp .env.example .env     # then fill in the values
npm start                # or: npm run dev  (restarts when you save a file)
```

Open http://localhost:3000 and create an account.

**The first account** takes over the old workspace (`DEFAULT_TENANT`, normally `org_123`), so the products, orders and chats from the old version are kept. Old data is upgraded automatically on start (see `src/db.js`).

## Where things are

```
server.js                 start here: connects routes and starts the server
src/
  config.js               every .env value, in one place
  db.js                   MongoDB connection + upgrade of old data
  jobs.js                 background jobs (publish posts, send comment replies, close old chats)
  models/                 one file per MongoDB collection
  lib/
    errors.js             fail(400, "message") and handle() for routes
    utils.js              small helpers (phone numbers, taka, Dhaka dates)
    crypto.js             token encryption + password hashing
    graph.js              Facebook Graph API client
    ai.js                 askAI(): calls Groq / any OpenAI-compatible API, returns JSON
    places.js             64 districts, Dhaka areas, delivery-zone matching
    notify.js             bell notifications
  middleware/auth.js      login cookie -> req.user, req.org
  services/               the business rules
    orders.js             create order, prices, status flow
    stock.js              reserve / release / ship / return stock
    fraud.js              risk score
    agent.js              AI sales agent (Messenger / Instagram)
    messenger.js          sending messages, 24-hour window
    comments.js           comment engine
    publisher.js          publishing to Facebook / Instagram
    metrics.js            Overview numbers
  routes/                 the /api URLs (one file per page)
public/
  index.html              the page shell
  css/app.css             all styles
  js/app.js               login, menu, page switching
  js/ui.js                helpers: esc, table, openModal, toast, onAction
  js/api.js               get/post/put/del to the server
  js/shared.js            product picker used by Orders and Inbox
  js/postEditor.js        post editor used by Content Studio and Calendar
  js/pages/*.js           one file per page
```

**To fix something on a page**, open `public/js/pages/<page>.js` for the screen and `src/routes/<page>.js` for its API.
The rules (prices, stock, statuses) are in `src/services/`.

### How a page file works
```js
export async function render(root, params) {
  onAction(root, { save: async (el) => { ... } });  // buttons with data-action="save"
  await draw(root);                                  // draw() fills root.innerHTML and can run again
}
```

## How the main flows work

**Order statuses**: `pending → confirmed → packed → shipped → delivered`. Any order can go to `cancelled` before it ships; `shipped` / `delivered` can go to `returned`. Fraud Shield puts risky orders `on_hold`. The allowed moves are in `NEXT` in `src/services/orders.js`.

**Stock**: each size/colour has `onHand` (in the shop), `reserved` (held by open orders) and `available` (= onHand − reserved).
- A new order reserves stock.
- Cancelling the order releases it.
- Shipping removes it from `onHand`.
- A return puts it back (if you tick "put back in stock").

Every change is saved in StockMovement ("History" on the Inventory page).

**AI chat** (`src/services/agent.js`):
1. A customer message comes in.
2. The AI answers using only your products and the "Shop knowledge" text, and fills the order draft.
3. When the draft is complete, the bot sends a summary with Confirm / Change buttons.
4. "Confirm" creates the order. The AI never calculates prices and never gives discounts.

**Comments** (`src/services/comments.js`):
- Each comment gets a category: price, stock, size, delivery, order, complaint, praise, spam or other.
- Buying questions get one private Messenger message and a public reply. The public reply is a template filled with your real price and is sent after a delay.
- Complaints and comments the engine doesn't understand wait for you.

## Meta app checklist
1. **Facebook Login → Valid OAuth Redirect URIs:** add `https://YOUR-DOMAIN/auth/facebook/callback`. It must be the same as `FB_REDIRECT_URI`.
2. **Webhooks:** nothing to do by hand. When the server starts it registers `PUBLIC_BASE_URL/webhooks/meta` with Meta (`src/services/webhookSetup.js`). The terminal must show `✅ Webhook registered`. This needs `PUBLIC_BASE_URL` (https) and `META_WEBHOOK_VERIFY_TOKEN` in `.env`.
3. **App mode Live:** Meta does not send real messages in Development mode.
4. **Connect Facebook:** in the app, open Meta Accounts and press Connect Facebook. Webhooks are switched on for each Page automatically. "Messages & comments" must show **On**.

## What v2 removed (to keep the code small)
- Removed modules: Brands, Strategy, Creative Studio, Meta Ads, Ads Optimizer, Budget, A/B tests, Reports, Competitors, Leads/CRM, Subscription plans, Courier API booking, teams and roles, approval workflow, n8n routes.
- Courier booking is replaced by typing the courier and tracking number when you ship.
- One login per business. Every account is the owner of its own shop.
