# AmritaKalakriti — अमृता कलाकृति

**Art · Craft · Creativity — *Every Creation Tells a Story.***

The e-commerce website for **amritakalakriti.com**: a handmade-art store for canvas paintings, watercolours, Pattachitra (Patta painting), Madhubani, Warli, Gond, mandala art and handcrafted décor. Its design follows the brand logo: cream paper, burnished gold, lotus pink and sage.

Built with Node.js, Express, SQLite and server-rendered EJS. It has no build step and needs no separate database server.

---

## Quick start

```bash
npm install
cp .env.example .env      # then edit SESSION_SECRET and ADMIN_PASSWORD
npm start                 # → http://localhost:3000
```

On first start the store creates its database in `data/store.db`. It then adds 8 art-form categories, a starter collection of 20 artworks and the admin account from `.env`.

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
- **Checkout:** Indian address validation (states, 6-digit PIN code, mobile number), then **Razorpay** (UPI, cards, net banking, wallets) or **Cash on Delivery**.
- **My orders:** a progress tracker, courier and tracking number, a status timeline, and cancellation before dispatch.
- **Wishlist**, **contact form** and **policy pages** (shipping, returns, privacy, terms). Razorpay requires these pages before it activates your account.

### For the admin (`/admin`)
- **Dashboard:** revenue, orders to fulfil, a 30-day sales chart, top sellers and recent orders.
- **Artworks:** add and edit artworks with multiple photos, price, "was" price, stock, featured and active flags.
- **Art forms (categories):** name, description, cover image and display order.
- **Orders:** filter and search, update status, add courier and tracking number, mark paid or refunded, notes, a printable invoice or packing slip, and CSV export.
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
- **One-of-a-kind safety:** stock is reserved inside a database transaction when an order is placed, so two buyers can never both buy the same original. Unpaid online orders release the reservation after 30 minutes.
- Razorpay payments are verified by HMAC signature in the browser flow and again by the webhook.
- Uploaded images are checked by their file contents, not just their names.

---

## Payments (Razorpay)

Without keys, checkout runs in **demo mode**. The payment step shows a simulated gateway, so the whole flow can be tested and no money is charged.

To take real payments:

1. Create a Razorpay account and complete KYC. The site already has the policy pages Razorpay asks for.
2. In the Razorpay Dashboard go to **Account & Settings → API Keys** and generate keys. Start with **Test mode** keys (`rzp_test_…`).
3. Add the keys to `.env`:
   ```
   RAZORPAY_KEY_ID=rzp_test_xxxxx
   RAZORPAY_KEY_SECRET=xxxxx
   ```
4. Add a webhook under **Webhooks**. URL: `https://amritakalakriti.com/webhooks/razorpay`. Events: `payment.captured` and `order.paid`. Put its secret in `RAZORPAY_WEBHOOK_SECRET`. The webhook confirms payments even if a customer closes the browser before returning to the site.
5. Restart the server. The console shows `Razorpay TEST keys`. When testing is done, swap in your live keys.

Cash on Delivery and online payments can each be switched on or off in **Admin → Settings**.

---

## Replacing the placeholder artwork

The starter collection uses illustrated placeholder images from `public/images/art/`, generated by `npm run art`. Replace them with real photographs before launch:

**Admin → Artworks → Edit → Images → upload → "Set as main"**.

Photo tips:
- Shoot in daylight, straight on, and crop to the edges of the artwork.
- Use JPEG or WebP, about 1600–2000 px on the long edge and under 1 MB each.
- Add 2–4 extra photos: a detail close-up, the edges or frame, and the piece in a room.

Edit or delete the sample artworks, and add your own, from the same screen.

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
  middleware.js           Auth, CSRF, flash messages, security headers, rate limiting
  uploads.js              Image upload handling
  routes/                 shop, auth, cart, checkout, account, admin, webhooks
views/                    EJS templates (storefront, account, checkout, admin)
public/
  css/base.css            Shared design system (colours, type, buttons, forms)
  css/store.css           Storefront styles
  css/admin.css           Admin styles
  js/main.js, js/admin.js Front-end behaviour (no external libraries)
  images/                 Logo cut-outs, favicons, placeholder art
  uploads/                Images uploaded from the admin
data/store.db             The database (back this up!)
```

---

## Deploying to amritakalakriti.com

Any server with **Node.js 20 or newer** works, for example a small Ubuntu VPS from DigitalOcean, Hostinger VPS, AWS Lightsail or similar.

```bash
# on the server
git clone <your repo> amritakalakriti && cd amritakalakriti
npm ci --omit=dev
cp .env.example .env && nano .env
#   NODE_ENV=production
#   BASE_URL=https://amritakalakriti.com
#   SESSION_SECRET=<long random string>
#   ADMIN_EMAIL / ADMIN_PASSWORD, Razorpay keys
npm i -g pm2 && pm2 start server.js --name amritakalakriti && pm2 save && pm2 startup
```

Put **Nginx** in front of the app with HTTPS from Let's Encrypt (`sudo certbot --nginx -d amritakalakriti.com -d www.amritakalakriti.com`):

```nginx
server {
  server_name amritakalakriti.com www.amritakalakriti.com;
  client_max_body_size 20m;            # allow artwork photo uploads
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Then point the domain's DNS **A record** at the server's IP address.

**Backups:** copy `data/` (the database) and `public/uploads/` (artwork photos) regularly, for example with a nightly cron job.

---

## Ideas for later
- "Forgot password" emails and order-confirmation emails (needs an email provider such as Zoho, Brevo or Amazon SES)
- Discount coupons
- Shiprocket integration for automatic courier booking and tracking
- GST invoices with HSN codes
- Automatic image resizing (for example with `sharp`)
