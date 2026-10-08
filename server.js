'use strict';

/*
 * AgriLink Zambia - Node.js server
 * Uses only built-in Node modules, so there is nothing to install.
 *   - serves the website from the /public folder
 *   - handles register, login, logout and the three request forms
 *   - saves data as JSON files in the /data folder
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const SESSION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_BODY_BYTES = 100 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function sendJSON(res, status, body, extraHeaders = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        'Cache-Control': 'no-store',
        ...extraHeaders,
    });
    res.end(payload);
}

/* ------------------------------------------------------------------ */
/* Storage: one JSON file per kind of data                             */
/* ------------------------------------------------------------------ */

function load(name) {
    const file = path.join(DATA_DIR, `${name}.json`);
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

function save(name, rows) {
    const file = path.join(DATA_DIR, `${name}.json`);
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(rows, null, 2));
    fs.renameSync(temp, file); // replace in one step so a crash can't leave half a file
}

function addRow(name, row) {
    const rows = load(name);
    rows.push(row);
    save(name, rows);
}

/* ------------------------------------------------------------------ */
/* Passwords (never stored as plain text)                              */
/* ------------------------------------------------------------------ */

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(password, salt, 64);
    return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
    const [saltHex, hashHex] = stored.split(':');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
}

// Used when the account doesn't exist, so a wrong email takes as long as a wrong password
const DUMMY_HASH = `${'00'.repeat(16)}:${'00'.repeat(64)}`;

/* ------------------------------------------------------------------ */
/* Sessions (kept in memory: everyone is logged out if the server restarts) */
/* ------------------------------------------------------------------ */

const sessions = new Map(); // token -> { userId, expires }

function createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { userId, expires: Date.now() + SESSION_MS });
    return token;
}

function parseCookies(header = '') {
    const cookies = {};
    header.split(';').forEach((part) => {
        const index = part.indexOf('=');
        if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    });
    return cookies;
}

function sessionCookie(token, maxAgeSeconds) {
    const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
    if (IS_PROD) flags.push('Secure');
    return `sid=${token}; ${flags.join('; ')}`;
}

function currentUser(req) {
    const token = parseCookies(req.headers.cookie).sid;
    const session = token && sessions.get(token);
    if (!session) return null;
    if (session.expires < Date.now()) {
        sessions.delete(token);
        return null;
    }
    return load('users').find((user) => user.id === session.userId) || null;
}

function requireUser(req) {
    const user = currentUser(req);
    if (!user) throw httpError(401, 'Please log in first, then try again.');
    return user;
}

/* ------------------------------------------------------------------ */
/* Simple rate limit for login and register                            */
/* ------------------------------------------------------------------ */

const attempts = new Map(); // ip -> { count, resetAt }

function rateLimit(req, limit = 10, windowMs = 15 * 60 * 1000) {
    const ip = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = attempts.get(ip);
    if (!entry || entry.resetAt < now) {
        entry = { count: 0, resetAt: now + windowMs };
        attempts.set(ip, entry);
    }
    entry.count += 1;
    if (entry.count > limit) {
        throw httpError(429, 'Too many attempts. Please wait a few minutes and try again.');
    }
}

/* ------------------------------------------------------------------ */
/* Reading and checking what the browser sends                         */
/* ------------------------------------------------------------------ */

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let tooBig = false;

        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                tooBig = true;
                return; // keep draining, but stop storing
            }
            chunks.push(chunk);
        });
        req.on('error', reject);
        req.on('end', () => {
            if (tooBig) return reject(httpError(413, 'That request is too large.'));
            const raw = Buffer.concat(chunks).toString('utf8');
            const type = req.headers['content-type'] || '';
            try {
                const body = type.includes('application/json')
                    ? JSON.parse(raw || '{}')
                    : Object.fromEntries(new URLSearchParams(raw));
                if (body === null || typeof body !== 'object' || Array.isArray(body)) {
                    throw new Error('not an object');
                }
                resolve(body);
            } catch {
                reject(httpError(400, 'Invalid request.'));
            }
        });
    });
}

function text(value, label, { min = 1, max = 200 } = {}) {
    const clean = typeof value === 'string' ? value.trim() : '';
    if (clean.length === 0) throw httpError(400, `${label} is required.`);
    if (clean.length < min) throw httpError(400, `${label} must be at least ${min} characters.`);
    if (clean.length > max) throw httpError(400, `${label} is too long.`);
    return clean;
}

function number(value, label, { min, max }) {
    const n = Number(value);
    if (value === '' || value === null || !Number.isFinite(n) || n < min || n > max) {
        throw httpError(400, `${label} must be a number between ${min} and ${max}.`);
    }
    return n;
}

function email(value) {
    const clean = text(value, 'Email', { max: 254 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw httpError(400, 'Please enter a valid email address.');
    return clean;
}

function phone(value) {
    const clean = text(value, 'Phone number', { max: 20 });
    if (!/^\+?[0-9 ()-]{7,20}$/.test(clean)) throw httpError(400, 'Please enter a valid phone number.');
    return clean;
}

const normalisePhone = (value) => value.replace(/[^\d+]/g, '');

function futureDate(value, label) {
    const clean = text(value, label, { max: 10 });
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(clean) || Number.isNaN(Date.parse(clean))) {
        throw httpError(400, `${label} must be a valid date.`);
    }
    if (clean < yesterday) throw httpError(400, `${label} cannot be in the past.`);
    return clean;
}

const ROLES = ['farmer', 'buyer', 'transporter'];
const CONTACT_TOPICS = ['General question', 'Selling products', 'Buying products', 'Transport', 'Report a problem'];

/* ------------------------------------------------------------------ */
/* API routes                                                          */
/* ------------------------------------------------------------------ */

const routes = {
    'GET /api/me': async (req, res) => {
        const user = currentUser(req);
        sendJSON(res, 200, { user: user ? { name: user.name, role: user.role } : null });
    },

    'POST /api/register': async (req, res) => {
        rateLimit(req);
        const body = await readBody(req);

        const role = text(body.role, 'Role', { max: 20 });
        if (!ROLES.includes(role)) throw httpError(400, 'Please choose farmer, buyer or transporter.');

        const name = text(body.name, 'Full name', { max: 100 });
        const userEmail = email(body.email);
        const userPhone = phone(body.phone);
        const location = text(body.location, 'Town or province', { max: 100 });
        const password = text(body.password, 'Password', { min: 8, max: 200 });
        if (body.password !== body.confirm) throw httpError(400, 'Passwords do not match.');
        if (!body.terms) throw httpError(400, 'Please accept the terms and conditions.');

        const users = load('users');
        if (users.some((user) => user.email === userEmail)) {
            throw httpError(409, 'An account with that email already exists.');
        }

        const user = {
            id: crypto.randomUUID(),
            role,
            name,
            email: userEmail,
            phone: userPhone,
            phoneKey: normalisePhone(userPhone),
            location,
            passwordHash: await hashPassword(password),
            createdAt: new Date().toISOString(),
        };
        users.push(user);
        save('users', users);

        const token = createSession(user.id);
        sendJSON(res, 201, { ok: true, message: 'Account created. Welcome to AgriLink!', redirect: '/index.html' }, {
            'Set-Cookie': sessionCookie(token, SESSION_MS / 1000),
        });
    },

    'POST /api/login': async (req, res) => {
        rateLimit(req);
        const body = await readBody(req);
        const username = text(body.username, 'Email or phone number', { max: 254 });
        const password = text(body.password, 'Password', { max: 200 });

        const lowered = username.toLowerCase();
        const phoneKey = normalisePhone(username);
        const user = load('users').find((u) => u.email === lowered || (phoneKey.length >= 7 && u.phoneKey === phoneKey));

        const valid = await verifyPassword(password, user ? user.passwordHash : DUMMY_HASH);
        if (!user || !valid) throw httpError(401, 'Incorrect email, phone number or password.');

        const token = createSession(user.id);
        sendJSON(res, 200, { ok: true, message: `Welcome back, ${user.name}.`, redirect: '/index.html' }, {
            'Set-Cookie': sessionCookie(token, SESSION_MS / 1000),
        });
    },

    'POST /api/logout': async (req, res) => {
        const token = parseCookies(req.headers.cookie).sid;
        if (token) sessions.delete(token);
        sendJSON(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    },

    // Farmers: list produce for sale
    'POST /api/listings': async (req, res) => {
        const user = requireUser(req);
        const body = await readBody(req);
        addRow('listings', {
            id: crypto.randomUUID(),
            userId: user.id,
            farmerName: text(body.name, 'Your name', { max: 100 }),
            location: text(body.location, 'Farm location', { max: 100 }),
            product: text(body.product, 'Product', { max: 100 }),
            quantityKg: number(body.quantity, 'Quantity', { min: 1, max: 1000000 }),
            pricePerKg: number(body.price, 'Price', { min: 0, max: 1000000 }),
            createdAt: new Date().toISOString(),
        });
        sendJSON(res, 201, { ok: true, message: 'Thank you! Your listing has been saved.' });
    },

    // Buyers: bulk orders
    'POST /api/orders': async (req, res) => {
        const user = requireUser(req);
        const body = await readBody(req);
        addRow('orders', {
            id: crypto.randomUUID(),
            userId: user.id,
            buyerName: text(body.name, 'Your name or business', { max: 100 }),
            phone: phone(body.phone),
            product: text(body.product, 'Product needed', { max: 100 }),
            quantityKg: number(body.quantity, 'Quantity', { min: 1, max: 1000000 }),
            address: text(body.address, 'Delivery address', { max: 300 }),
            createdAt: new Date().toISOString(),
        });
        sendJSON(res, 201, { ok: true, message: 'Thank you! Your order has been received.' });
    },

    // Anyone: request a transporter
    'POST /api/transport-requests': async (req, res) => {
        const user = requireUser(req);
        const body = await readBody(req);
        addRow('transport-requests', {
            id: crypto.randomUUID(),
            userId: user.id,
            pickup: text(body.pickup, 'Pickup location', { max: 200 }),
            destination: text(body.destination, 'Destination', { max: 200 }),
            produce: text(body.produce, 'Type of produce', { max: 100 }),
            weightKg: number(body.weight, 'Weight', { min: 1, max: 1000000 }),
            date: futureDate(body.date, 'Delivery date'),
            createdAt: new Date().toISOString(),
        });
        sendJSON(res, 201, { ok: true, message: 'Thank you! Your transport request has been sent.' });
    },

    // Everything the logged-in person has done (for the My Account page)
    'GET /api/my-activity': async (req, res) => {
        const user = requireUser(req);
        const mine = (name) => load(name)
            .filter((row) => row.userId === user.id)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) // newest first
            .map(({ userId, ...rest }) => rest);

        sendJSON(res, 200, {
            user: {
                name: user.name,
                role: user.role,
                email: user.email,
                phone: user.phone,
                location: user.location,
                createdAt: user.createdAt,
            },
            listings: mine('listings'),
            orders: mine('orders'),
            transportRequests: mine('transport-requests'),
        });
    },

    // Farmers: remove one of their own listings
    'POST /api/listings/delete': async (req, res) => {
        const user = requireUser(req);
        const body = await readBody(req);
        const id = text(body.id, 'Listing', { max: 60 });

        const rows = load('listings');
        const index = rows.findIndex((row) => row.id === id && row.userId === user.id); // only your own
        if (index === -1) throw httpError(404, 'Listing not found.');
        rows.splice(index, 1);
        save('listings', rows);
        sendJSON(res, 200, { ok: true, message: 'Listing deleted.' });
    },

    // Anyone (no login needed): send a message to the AgriLink team
    'POST /api/contact': async (req, res) => {
        rateLimit(req, 5);
        const body = await readBody(req);
        const topic = text(body.subject, 'Subject', { max: 40 });
        if (!CONTACT_TOPICS.includes(topic)) throw httpError(400, 'Please choose a subject from the list.');
        addRow('messages', {
            id: crypto.randomUUID(),
            name: text(body.name, 'Your name', { max: 100 }),
            email: email(body.email),
            subject: topic,
            message: text(body.message, 'Message', { min: 10, max: 2000 }),
            createdAt: new Date().toISOString(),
        });
        sendJSON(res, 201, { ok: true, message: 'Thank you! We have received your message and will reply soon.' });
    },

    // Public list of what farmers have listed (for a future dynamic products page)
    'GET /api/listings': async (req, res) => {
        const listings = load('listings')
            .map(({ userId, ...publicFields }) => publicFields)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) // newest first
            .slice(0, 50);
        sendJSON(res, 200, { listings });
    },
};

/* ------------------------------------------------------------------ */
/* Static files from /public                                           */
/* ------------------------------------------------------------------ */

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
};

function notFound(res) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Page not found');
}

function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        return res.end();
    }

    let relative;
    try {
        relative = decodeURIComponent(pathname);
    } catch {
        return notFound(res);
    }
    if (relative.includes('\0')) return notFound(res);
    if (relative.endsWith('/')) relative += 'index.html';

    const file = path.join(PUBLIC_DIR, relative);
    // Never serve anything outside /public (blocks ../ tricks)
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return notFound(res);

    const type = MIME_TYPES[path.extname(file).toLowerCase()];
    if (!type) return notFound(res);

    fs.stat(file, (error, stats) => {
        if (error || !stats.isFile()) return notFound(res);
        res.writeHead(200, {
            'Content-Type': type,
            'Content-Length': stats.size,
            'Cache-Control': 'no-cache',
        });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(file).pipe(res);
    });
}

/* ------------------------------------------------------------------ */
/* The server                                                          */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'"
    );

    try {
        const { pathname } = new URL(req.url, 'http://localhost');

        if (pathname.startsWith('/api/')) {
            const handler = routes[`${req.method} ${pathname}`];
            if (!handler) throw httpError(404, 'Not found.');
            return await handler(req, res);
        }

        serveStatic(req, res, pathname);
    } catch (error) {
        if (error.status) {
            return sendJSON(res, error.status, { ok: false, message: error.message });
        }
        console.error(error);
        sendJSON(res, 500, { ok: false, message: 'Something went wrong on our side. Please try again.' });
    }
});

server.listen(PORT, () => {
    console.log(`AgriLink Zambia is running at http://localhost:${PORT}`);
});
