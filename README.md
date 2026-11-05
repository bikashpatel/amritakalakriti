# AmritaKalakriti — अमृता कलाकृति

**Art · Craft · Creativity — *Every Creation Tells a Story.***

The e-commerce website for **amritakalakriti.com**: a handmade-art store for canvas paintings, watercolours, Pattachitra (Patta painting), Madhubani, Warli, Gond, mandala art and handcrafted décor. Its design follows the brand logo: cream paper, burnished gold, lotus pink and sage.

Built with Node.js, Express, SQLite and server-rendered EJS. It has no build step and needs no separate database server.

This application is designed, developed & maintained by [ELARXSYS.COM](https://elarxsys.com).

---

## Quick start

```bash
npm install
cp .env.example .env      # then edit SESSION_SECRET and ADMIN_PASSWORD
npm start                 # → http://localhost:3000
```

On first start the store creates its database in `data/store.db`. It then adds 8 art-form categories, the studio's opening collection of 18 artworks and the admin account from `.env`.

- **Storefront:** http://localhost:3000
- **Admin panel:** http://localhost:3000/admin. Sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD` from `.env`.

Use `npm run dev` to restart the server automatically while editing.
To reset the admin password to the one in `.env`, run `npm run seed -- --reset-admin`.

---

## What's included

### For customers
- **Home page:** hero with framed artworks, art-form arches, featured works, brand story, new arrivals, commission section and newsletter sign-up.
- **Shop:** filter by art form, price band and availability; search; sort; pagination.
- **Artwork page:** image gallery and an **"On your wall"** preview that shows the piece to scale above a sofa. It also shows details, care and shipping info, reviews (with a "verified buyer" badge) and related works.
- **Accounts:** register, sign in, saved address, change password.
- **Cart:** add to cart without a page reload, quantity limits by stock, and a free-shipping progress bar.
- **Checkout:** Indian address validation (states, 6-digit PIN code, mobile number), then **UPI** paid straight to the store's bank (QR code or UPI app link), **Razorpay** (cards, UPI, net banking, wallets, once its keys are added) or **Cash on Delivery**.
- **My orders:** a progress tracker, courier and tracking number, a status timeline, and cancellation before dispatch.
- **Wishlist**, **contact form** and **policy pages** (shipping, returns, privacy, terms). Razorpay requires these pages before it activates your account.

### For the admin (`/admin`)
- **Dashboard:** revenue, orders to fulfil, a 30-day sales chart, top sellers and recent orders.
- **Artworks:** add and edit artworks with multiple photos, price, "was" price, stock, featured and active flags.
- **Art forms (categories):** name, description, cover image and display order.
- **Orders:** filter and search, check UPI payments against their reference numbers, update status, add courier and tracking number, mark paid or refunded, notes, a printable invoice or packing slip, and CSV export.
- **Customers:** order history and lifetime value; activate or deactivate accounts, promote to admin, reset passwords.
- **Reviews:** hide or delete reviews.
- **Messages and subscribers:** read contact-form messages; export subscribers as CSV.
- **Pages:** edit the About and policy pages.
- **Settings:** store details, homepage text, announcement bar, shipping fee and free-shipping threshold, payment options, social links.

### Built-in protections
- Passwords are hashed with bcrypt, and sign-in is rate-limited.
- Every form has CSRF protection.
- Every database query is parameterised.
- Security headers include a strict Content Security Policy.
- Prices and stock are always recalculated on the server.
- **One-of-a-kind safety:** stock is reserved inside a database transaction when an order is placed, so two buyers can never both buy the same original. Unpaid online orders release the reservation after 30 minutes; UPI orders keep it once the customer sends a payment reference, until the store confirms or cancels.
- Razorpay payments are verified by HMAC signature in the browser flow and again by the webhook.
- Uploaded images are checked by their file contents, not just their names.

---

## Payments

Customers can pay three ways. Each can be switched on or off in **Admin → Settings → Payments**.

| Method | Money goes to | Confirmed by | Set up |
|---|---|---|---|
| **UPI** | Your bank account, directly | You, from the order page | Add your UPI ID in Admin → Settings |
| **Razorpay** | Your Razorpay account | Automatically | Add keys to `.env` (below) |
| **Cash on delivery** | The courier collects it | You, from the order page | Nothing |

### UPI (direct to your bank)

1. Get a **business UPI ID** from PhonePe Business, Paytm for Business, Google Pay for Business or your bank. Many UPI apps block website payments to personal UPI IDs.
2. In **Admin → Settings → Payments**, tick UPI, enter the UPI ID and the name on that account, and save.

At checkout the customer sees a QR code (on a computer) or an "Open UPI app" button (on a phone) with the amount and order number filled in. After paying they type the 12-digit UPI reference number (UTR) into the site, and the order moves to **Verifying payment**. The dashboard and the Orders menu show how many are waiting.

To confirm one, open the order, find the payment in your bank or UPI app, and click **Payment received**. If it never arrived, click **Not received — cancel order** and the artwork goes back on sale. **Never ship before the money is in your account:** a reference number on its own is not proof of payment.

Orders where the customer never sends a reference are cancelled after 30 minutes, like any other unpaid online order. Refunds for UPI orders are sent by you from your bank or UPI app.

### Razorpay

Razorpay switches on as soon as its keys are in `.env`; no code changes are needed. Without keys it is hidden on the live site. In development (`NODE_ENV` not `production`) it runs in **demo mode** instead: the payment step shows a simulated gateway, so the whole flow can be tested and no money is charged.

To take Razorpay payments:

1. Create a Razorpay account and complete KYC. The site already has the policy pages Razorpay asks for.
2. In the Razorpay Dashboard go to **Account & Settings → API Keys** and generate keys. Start with **Test mode** keys (`rzp_test_…`).
3. Add the keys to `.env`:
   ```
   RAZORPAY_KEY_ID=rzp_test_xxxxx
   RAZORPAY_KEY_SECRET=xxxxx
   ```
4. Add a webhook under **Webhooks**. URL: `https://amritakalakriti.com/webhooks/razorpay`. Events: `payment.captured` and `order.paid`. Put its secret in `RAZORPAY_WEBHOOK_SECRET`. The webhook confirms payments even if a customer closes the browser before returning to the site.
5. Restart the server. The console shows `Razorpay → TEST keys`. When testing is done, swap in your live keys.

Once Razorpay is live you can keep UPI on as well, or switch it off in Admin → Settings.

---

## Artworks

A new store starts with the studio's opening collection: 18 photographed artworks listed in `src/seed.js`, with their photos in `public/images/artworks/`. This happens only once, when the database is empty; after that, artworks are managed from the admin and the seed list is never read again.

Add, edit or hide artworks in **Admin → Artworks**. To change a photo: **Edit → Images → upload → "Set as main"**. Art forms without an artwork of their own show an illustration from `public/images/art/` (generated by `npm run art`) as their cover.

Photo tips:
- Shoot in daylight, straight on, and crop to the edges of the artwork.
- Use JPEG or WebP, about 1600–2000 px on the long edge and under 1 MB each. Photos straight from a phone can be 5–8 MB, which makes pages slow, so shrink them first.
- Add 2–4 extra photos: a detail close-up, the edges or frame, and the piece in a room.

---

## Project structure

```
server.js                 App entry: middleware, routes, error pages
src/
  config.js               Settings from .env
  db.js                   SQLite schema and default settings
  seed.js                 First-run categories, artworks and admin user
  cart.js / orders.js     Cart pricing, order creation, stock reservation, payments state
  payments.js             Razorpay API and signature checks
  upi.js                  Direct UPI: payment links, QR codes, reference numbers
  middleware.js           Auth, CSRF, flash messages, security headers, rate limiting
  uploads.js              Image upload handling
  routes/                 shop, auth, cart, checkout, account, admin, webhooks
views/                    EJS templates (storefront, account, checkout, admin)
public/
  css/base.css            Shared design system (colours, type, buttons, forms)
  css/store.css           Storefront styles
  css/admin.css           Admin styles
  js/main.js, js/admin.js Front-end behaviour (no external libraries)
  images/                 Logo, peacock badge, favicons, share image, art-form illustrations
  images/artworks/        Photos of the opening collection
  uploads/                Images uploaded from the admin
scripts/                  generate-art.js (art-form illustrations), backup.js (database backup)
Dockerfile                Production container image
docker-compose.yml        App + optional Cloudflare Tunnel
data/store.db             The database (back this up!) — /app/data in Docker
```

---

## Deploying with Docker

The app ships as a container image. The `Dockerfile` builds a small production image that runs as a non-root user and has a built-in health check at `/healthz`.

**Before you deploy, two rules matter:**
1. **Mount a persistent volume at `/app/data`.** The SQLite database and every uploaded photo live there. Without a volume, a restart or redeploy **erases all orders, customers and photos**.
2. **Run exactly one container.** SQLite is a single file, so two copies of the app would each keep their own separate data.

### Settings (environment variables)

Set these in `.env` (Docker Compose) or as environment variables on your platform. The full list is in `.env.example`.

| Variable | Value |
|---|---|
| `SESSION_SECRET` | **Required.** A random string of 32+ characters; the app refuses to start without one. Generate with `openssl rand -hex 32`. |
| `BASE_URL` | `https://amritakalakriti.com` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | The first admin account, created on the first start. |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Your Razorpay keys. If left empty, Razorpay is hidden in production and runs in demo mode in development. |
| `BEHIND_CLOUDFLARE` | `1` when all traffic comes through Cloudflare, e.g. a Cloudflare Tunnel. |
| `TRUST_PROXY` | `1` (the default) behind one proxy or load balancer. |

The image already sets `NODE_ENV=production`, `PORT=3000` and `DATA_DIR=/app/data`.

### Option A — Docker Compose on any server (recommended)

```bash
git clone https://github.com/bikashpatel/amritakalakriti.git && cd amritakalakriti
cp .env.example .env && nano .env        # fill in the variables above
docker compose up -d --build             # site on http://127.0.0.1:3000, data in the "store-data" volume
```

**Connect your Cloudflare domain with a Cloudflare Tunnel.** This needs no open ports, no Nginx and no SSL certificates.
1. In the Cloudflare dashboard, go to **Zero Trust → Networks → Tunnels → Create a tunnel** and choose type **Cloudflared**.
2. Add a **public hostname**: `amritakalakriti.com` (and `www`) pointing to the service `http://app:3000`.
3. Copy the tunnel token into `.env` as `CLOUDFLARE_TUNNEL_TOKEN`, and set `BEHIND_CLOUDFLARE=1`.
4. Run `docker compose --profile tunnel up -d`.

### Option B — Build the image yourself and push it to a registry

On an Apple Silicon Mac, build for the x86 servers that cloud providers use:

```bash
docker buildx build --platform linux/amd64 -t amritakalakriti .

# Example: push to Google Artifact Registry
gcloud artifacts repositories create web --repository-format=docker --location=asia-south1
docker tag amritakalakriti asia-south1-docker.pkg.dev/<PROJECT_ID>/web/amritakalakriti:1
docker push asia-south1-docker.pkg.dev/<PROJECT_ID>/web/amritakalakriti:1
```

Then run it with a persistent volume at `/app/data`. For example:

```bash
docker run -d --name amritakalakriti --restart unless-stopped \
  -p 127.0.0.1:3000:3000 --env-file .env -v store-data:/app/data \
  asia-south1-docker.pkg.dev/<PROJECT_ID>/web/amritakalakriti:1
```

> **About Google Cloud Run:** Cloud Run's disk is wiped whenever the service restarts, and it can start several copies of the app. Its Cloud Storage volume mounts are not safe for SQLite. Cloud Run is therefore **not a good fit as-is**. Use a VM or another host that gives one container a real persistent disk. Running on Cloud Run would mean moving the database to Cloud SQL.

### Cloudflare notes
- With a Tunnel, Cloudflare handles HTTPS automatically. Without a Tunnel (an A record pointing at your server), set **SSL/TLS → Full (strict)** and serve HTTPS from your server.
- CSS and JavaScript links carry a version tag that changes with every deploy, so Cloudflare's cache never serves stale styles.
- Razorpay sends webhooks to `/webhooks/razorpay`. If you enable Bot Fight Mode or other WAF rules, check in the Razorpay dashboard that webhooks are still delivered.

### Backups

```bash
docker compose exec app node scripts/backup.js     # safe while the site is running
```

This writes `/app/data/backups/store-<date>.db` and keeps the newest 14. Copy the whole volume off the server regularly, for example once a night with cron. It holds the database, the backups and the `uploads/` photos.

```bash
docker run --rm -v amritakalakriti_store-data:/data -v "$PWD":/out alpine tar czf /out/ak-$(date +%F).tgz -C /data .
```

Run `docker volume ls` to see the volume's exact name.

### Running without Docker

Install Node.js 20 or newer, then:

```bash
npm ci --omit=dev
NODE_ENV=production node server.js
```

Keep it running with PM2 or systemd, and put a Cloudflare Tunnel or Nginx in front. Run backups with `npm run backup`.

---

## Ideas for later
- "Forgot password" emails and order-confirmation emails (needs an email provider such as Zoho, Brevo or Amazon SES)
- Discount coupons
- Shiprocket integration for automatic courier booking and tracking
- GST invoices with HSN codes
- Automatic image resizing (for example with `sharp`)
