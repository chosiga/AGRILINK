# AgriLink Zambia

## Run it

1. Install Node.js 18 or newer from https://nodejs.org
2. Open a terminal in this folder (the one with `server.js`)
3. Run:

```
node server.js
```

4. Open http://localhost:3000 in your browser. (Stop the server with Ctrl + C.)

No `npm install` is needed: the server only uses Node's built-in modules.

## Folders

```
agrilink/
├── server.js        the Node.js server and API
├── package.json
├── data/            created automatically; saved accounts, listings, orders (do not share)
└── public/          the website: HTML, styles.css, script.js, images/
```

## What the server does

| Request | Does |
|---|---|
| `POST /api/register` | Creates an account and logs the person in |
| `POST /api/login` | Logs in with email or phone number |
| `POST /api/logout` | Logs out |
| `GET /api/me` | Says who is logged in |
| `POST /api/listings` | Farmer lists produce (login required) |
| `POST /api/orders` | Buyer places an order (login required) |
| `POST /api/transport-requests` | Requests a transporter (login required) |
| `GET /api/listings` | Public list of farmer listings |

## Before going live

- Set `NODE_ENV=production` and serve the site over HTTPS, so the login cookie is marked Secure.
- Sessions are kept in memory, so everyone is logged out when the server restarts.
- `data/*.json` is fine for learning and small tests. For a real launch, move to a database such as PostgreSQL or SQLite.
- Back up the `data/` folder, and keep it out of Git (it is in `.gitignore`).
