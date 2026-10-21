# AgriLink Zambia

A marketplace that connects farmers, buyers and transporters. Node.js server, Oracle database.

## Folders

```
AGRILINK/
├── server.js            the website server and API
├── store.js             every database query (the server never writes SQL itself)
├── db.js                the connection to Oracle
├── setup-database.js    creates or safely updates the marketplace tables
├── create-user.js       creates the AGRILINK database user (run once)
├── server-json.js       the old version that saved to files; kept as a safety net
├── .env                 your database login details (secret: never share or upload)
├── wallet/              Oracle connection files (secret: never share or upload)
└── public/              the website: HTML, css/, js/, images/
```

## One-time setup

1. Install Node.js 18 or newer from https://nodejs.org
2. In this folder run: `npm install oracledb dotenv`
3. Put the Oracle wallet files in the `wallet` folder.
4. Create `.env` with these four lines (no spaces, no quote marks):
   ```
   DB_USER=AGRILINK
   DB_PASSWORD=the password of the AGRILINK database user
   DB_CONNECTION_STRING=agrilinkdb_medium
   DB_WALLET_PASSWORD=the password you chose when downloading the wallet
   ```
   Use only letters and numbers in passwords. The connection name must match a name in `wallet/tnsnames.ora`.
5. Create or update the tables: `node setup-database.js` (safe to run again; it preserves existing marketplace records). The script adds the catalog listing fields, verification/review support, and marketplace workflow columns to an existing database.

## Run the website

```
node server.js
```

You should see `AgriLink Zambia is running at http://localhost:3000` and `Connected to the Oracle database.`
Open http://localhost:3000. Stop it with Ctrl + C.

If it cannot reach the database it says why and stops. Common causes:

- wrong user name or password in `.env`
- wrong wallet password in `.env`
- the database is stopped in the Oracle console (free databases stop after 7 days of no use: open the console and start it)
- a table is missing: run `node setup-database.js`

## The tables

| Table | Holds |
|---|---|
| APP_USERS | accounts: role, contact details, scrambled password |
| LISTINGS | farmer listings, including category, description, unit, available/minimum quantity, ZMW price, province, product images, harvest date, and delivery availability |
| ORDERS | buyers' orders, linked to a listing and its farmer, with the listing unit and buyer's payment preference |
| TRANSPORT_REQUESTS | delivery jobs and who accepted them |
| NOTIFICATIONS | the alerts shown on the site |
| CONTACT_MESSAGES | messages from the contact page |
| LOGIN_SESSIONS | logins (only a scrambled copy of each login token), so people stay logged in when the server restarts |
| FARMER_REVIEWS | one buyer rating per eligible, completed farmer order |

To read the data, open the Oracle console, then Database actions, then SQL, and run for example
`SELECT * FROM contact_messages ORDER BY created_at DESC;`

## Going back to the old version

`node server-json.js` runs the old server, which saves to files in a `data` folder and needs no database.
Data in the database and data in those files are separate.

## API

| Request | Does |
|---|---|
| `POST /api/register` | creates an account and logs the person in |
| `POST /api/login` | logs in with email or phone number |
| `POST /api/logout` | logs out |
| `GET /api/me` | who is logged in, and how many unread notifications |
| `GET /api/my-activity` | everything for the My Account page |
| `POST /api/listings` | an authenticated farmer creates a catalog listing |
| `POST /api/listings/update` | a farmer updates their own listing |
| `POST /api/listings/delete` | a farmer removes a listing (waiting orders are cancelled) |
| `GET /api/listings` | public, paginated catalog with name/category/description search, price, province, quantity, rating, verification, delivery filters, and sorting |
| `GET /api/listing?id=` | public product details and recent verified-purchase seller reviews |
| `POST /api/orders` | a buyer orders, optionally from one listing, and selects PayPal or Mobile Money |
| `POST /api/orders/respond` | a farmer accepts or declines an order |
| `POST /api/transport-requests` | asks for a transporter |
| `POST /api/transport-requests/accept` | a transporter takes a job |
| `POST /api/transport-requests/deliver` | a transporter marks a job delivered |
| `POST /api/transport-requests/cancel` | the requester cancels a job nobody has taken |
| `POST /api/notifications/read` | marks notifications as read |
| `POST /api/contact` | sends a message to the AgriLink team |
| `GET /api/admin/overview` | private platform metrics and farmer verification queue (admins only) |
| `POST /api/admin/farmers/verify` | verifies or un-verifies a farmer (admins only) |
| `POST /api/orders/confirm-delivery` | confirms a delivered order (the buyer only) |
| `POST /api/orders/review` | submits one review for a confirmed farmer order (the buyer only) |

## Roles, admin access and seller trust

Public registration is limited to farmer, buyer, and transporter accounts. The server checks roles for marketplace writes; hiding a dashboard control is not used as a permission check. Admin accounts must be provisioned by an authorised database operator and are never available from the public registration form.

To provision the first admin, first register a normal account, then have a trusted database operator promote that exact account:

```sql
UPDATE app_users SET user_role = 'admin' WHERE email = 'admin@example.com';
COMMIT;
```

Only perform this operation for a verified, trusted administrator. Admins can view platform counts and review farmer accounts in My Account, where they may grant or remove a farmer verification badge. The badge indicates an admin review, not a guarantee of product quality.

Buyer reviews are accepted only after a farmer has accepted the order, a transporter has marked delivery complete, and the buyer has confirmed receipt. A buyer can review a given order once. Public seller ratings are calculated from these stored reviews; no sample ratings or verification claims are invented.

The homepage uses the live farmer listings and farmer directory. The catalog supports nine categories: maize, tomatoes, groundnuts, soya beans, vegetables, rice, fruits, fertilizers and farming supplies, and other agricultural products. A new database may show empty-state messages until farmers create listings; it does not show pretend offers or fabricated prices.

Farmers can attach up to five JPEG, PNG, or WebP images per listing. Each file must be 1 MB or smaller, and all uploaded images together must total 5 MB or less. Images are validated by the server and stored under `public/uploads/listings/`; upload files are not accepted as free-form URLs. Listing mutations require an authenticated farmer session and enforce ownership on the server.

## Marketplace architecture

AgriLink uses the existing Node.js HTTP server and API, static semantic HTML, shared CSS/JavaScript, and Oracle persistence. The server validates submitted data and applies role/ownership checks before calling the SQL data layer. This keeps the application on its current stack without adding a frontend framework or duplicating databases.

The payment method stored with an order is a preference only. No payment credentials or secrets are sent to the browser and no payment is processed by this application.

## Notifications and email alerts

Notifications always work on the site: a count shows next to "Hi, Name" in the header, and the full list is at the top of the My Account page.

Email is optional and off by default. You need an account with an email service that has an HTTP API (the code is written for Resend, https://resend.com, and most similar services work the same way). Then start the server with these settings:

```
EMAIL_API_KEY="your-secret-key" EMAIL_FROM="AgriLink <alerts@yourdomain.com>" CONTACT_EMAIL="team@yourdomain.com" SITE_URL="https://your-site-address" node server.js
```

- `EMAIL_API_KEY` is the secret key from the email service. Never put it in a file you share or upload to Git.
- `EMAIL_FROM` must be an address on a domain you have verified with the email service.
- `CONTACT_EMAIL` is the team inbox that receives contact-form messages. The messages are also saved in `CONTACT_MESSAGES`.
- `SITE_URL` is the public address of your site, used for the link in each email.
- If you use a service other than Resend, also set `EMAIL_API_URL` to its send address.

In-app notifications and optional email alerts go to both the buyer and farmer when an order is placed from a farmer's listing. Buyers also get an in-app notification for a general order request. The contact form emails the team inbox when `CONTACT_EMAIL` and email settings are configured. Other emails go out when a farmer accepts or declines an order, a listing with waiting orders is removed, and a transporter accepts or delivers a job. New delivery jobs are shown to transporters on the site only. Emails never contain phone numbers.

Buyers can save PayPal or a Mobile Money network (MTN, Airtel or Zamtel Kwacha) as their preferred payment method. This records a preference only; it does not charge the buyer or initiate a provider payment. Buyer and farmer should arrange payment after the order is confirmed. To process real payments, configure and integrate payment-provider accounts and server-side credentials.

If the email service is down or the key is wrong, the site carries on working and the problem is printed in the Terminal.

## Before going live

- Set `NODE_ENV=production` and serve the site over HTTPS, so the login cookie is marked Secure.
- Keep `.env` and `wallet/` out of Git and out of any folder you upload (they are listed in `.gitignore`).
- Free Oracle databases stop after 7 days without activity and can be deleted if left stopped too long. Log in and start yours before that happens, and keep your own copies of important data.
