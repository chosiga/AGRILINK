'use strict';

/*
 * AgriLink Zambia - Node.js server
 *   - serves the website from the /public folder
 *   - handles register, login, logout and all the forms
 *   - keeps every record in the Oracle database (see db.js, store.js and setup-database.js)
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const db = require('./db');
const store = require('./store')(db);

const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_BODY_BYTES = 100 * 1024;
const MAX_LISTING_BODY_BYTES = 8 * 1024 * 1024;
const MAX_LISTING_IMAGE_BYTES = 1024 * 1024;
const MAX_LISTING_IMAGES = 5;
const LISTING_CATEGORIES = [
    'maize',
    'tomatoes',
    'groundnuts',
    'soya-beans',
    'vegetables',
    'rice',
    'fruits',
    'fertilizers-and-farming-supplies',
    'other-agricultural-products',
];
const LISTING_UNITS = ['kg', 'bag', 'tonne', 'crate', 'each', 'litre'];
const ZAMBIAN_PROVINCES = [
    'Central', 'Copperbelt', 'Eastern', 'Luapula', 'Lusaka',
    'Muchinga', 'Northern', 'North-Western', 'Southern', 'Western', 'Other',
];
const LISTING_UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads', 'listings');

// Optional email alerts. Leave these unset and the site still works (in-app notifications only).
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const EMAIL_API_URL = process.env.EMAIL_API_URL || 'https://api.resend.com/emails';
const EMAIL_API_KEY = process.env.EMAIL_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || ''; // e.g. "AgriLink <alerts@yourdomain.com>"
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || '';

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
/* Sessions (saved in the database, so logins survive a server restart) */
/* ------------------------------------------------------------------ */

// Only a scrambled (hashed) copy of each login token is stored, so a leaked database
// cannot be used to log in as someone.
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

async function createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    await store.createSession(hashToken(token), userId, SESSION_MS / 1000);
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

async function currentUser(req) {
    const token = parseCookies(req.headers.cookie).sid;
    if (!token) return null;
    return store.findSessionUser(hashToken(token)); // null when the session is unknown or has expired
}

async function requireUser(req) {
    const user = await currentUser(req);
    if (!user) throw httpError(401, 'Please log in first, then try again.');
    return user;
}

async function requireRole(req, allowedRoles) {
    const user = await requireUser(req);
    if (!allowedRoles.includes(user.role)) {
        throw httpError(403, 'Your account does not have permission to do that.');
    }
    return user;
}

/* ------------------------------------------------------------------ */
/* Simple rate limit for login and register                            */
/* ------------------------------------------------------------------ */

const attempts = new Map(); // ip -> { count, resetAt }

// Each kind of action (login and register, contact form) has its own counter per visitor
function rateLimit(req, limit = 10, windowMs = 15 * 60 * 1000, bucket = 'login') {
    const key = `${bucket}:${req.socket.remoteAddress || 'unknown'}`;
    const now = Date.now();
    let entry = attempts.get(key);
    if (!entry || entry.resetAt < now) {
        entry = { count: 0, resetAt: now + windowMs };
        attempts.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > limit) {
        throw httpError(429, 'Too many attempts. Please wait a few minutes and try again.');
    }
}

/* ------------------------------------------------------------------ */
/* Reading and checking what the browser sends                         */
/* ------------------------------------------------------------------ */

function readBody(req, maxBytes = MAX_BODY_BYTES) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let tooBig = false;

        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
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

function listingImagePaths(value) {
    const paths = Array.isArray(value)
        ? value
        : typeof value === 'string'
            ? value.split(/\r?\n/)
            : [];
    const clean = paths
        .map((image) => typeof image === 'string' ? image.trim() : '')
        .filter(Boolean);
    if (clean.some((image) => !/^\/(?:images\/[A-Za-z0-9._-]+\.(?:jpe?g|png|webp)|uploads\/listings\/[a-f0-9-]+\.(?:jpe?g|png|webp))$/i.test(image))) {
        throw httpError(400, 'Product images must be uploaded or chosen from AgriLink image folders.');
    }
    return [...new Set(clean.filter(Boolean))];
}

function validImageBytes(bytes, mime) {
    if (mime === 'image/png') {
        return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
    if (mime === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    return mime === 'image/webp'
        && bytes.length >= 12
        && bytes.toString('ascii', 0, 4) === 'RIFF'
        && bytes.toString('ascii', 8, 12) === 'WEBP';
}

async function prepareListingImages(body, existingImages = []) {
    const imagePaths = listingImagePaths(
        body.images === undefined ? existingImages : body.images
    );
    if (imagePaths.some((image) => image.startsWith('/uploads/listings/') && !existingImages.includes(image))) {
        throw httpError(400, 'Only images already attached to this listing can be reused.');
    }
    const uploads = body.imageFiles === undefined
        ? []
        : Array.isArray(body.imageFiles) ? body.imageFiles : [body.imageFiles];
    if (uploads.length + imagePaths.length > MAX_LISTING_IMAGES) {
        throw httpError(400, `A listing can have at most ${MAX_LISTING_IMAGES} product images.`);
    }

    const savedPaths = [];
    let totalBytes = 0;
    try {
        for (const upload of uploads) {
            if (typeof upload !== 'string') throw httpError(400, 'A product image upload is invalid.');
            const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(upload);
            if (!match) throw httpError(400, 'Product images must be JPEG, PNG, or WebP files.');

            const [, mime, encoded] = match;
            const bytes = Buffer.from(encoded, 'base64');
            if (bytes.toString('base64') !== encoded || !validImageBytes(bytes, mime)) {
                throw httpError(400, 'A product image is not a valid image file.');
            }
            if (bytes.length > MAX_LISTING_IMAGE_BYTES) {
                throw httpError(400, 'Each product image must be 1 MB or smaller.');
            }
            totalBytes += bytes.length;
            if (totalBytes > 5 * MAX_LISTING_IMAGE_BYTES) {
                throw httpError(400, 'Product images must total 5 MB or less.');
            }

            const extension = mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : 'webp';
            const filename = `${crypto.randomUUID()}.${extension}`;
            await fs.promises.mkdir(LISTING_UPLOAD_DIR, { recursive: true });
            await fs.promises.writeFile(path.join(LISTING_UPLOAD_DIR, filename), bytes, { flag: 'wx' });
            const saved = `/uploads/listings/${filename}`;
            savedPaths.push(saved);
            imagePaths.push(saved);
        }
    } catch (error) {
        await Promise.all(savedPaths.map((image) =>
            fs.promises.unlink(path.join(PUBLIC_DIR, image.slice(1))).catch((cleanupError) => {
                console.error('Could not remove an incomplete listing image:', cleanupError.message);
            })
        ));
        throw error;
    }

    if (imagePaths.length === 0) throw httpError(400, 'Add at least one product image to your listing.');
    return { imageUrls: imagePaths, savedPaths };
}

async function removeListingUploads(imageUrls) {
    const uploads = listingImagePaths(imageUrls).filter((image) => image.startsWith('/uploads/listings/'));
    await Promise.all(uploads.map((image) =>
        fs.promises.unlink(path.join(PUBLIC_DIR, image.slice(1))).catch((error) => {
            if (error.code !== 'ENOENT') console.error('Could not remove a listing image:', error.message);
        })
    ));
}

function listingFields(body, user, imageUrls) {
    const category = text(body.category, 'Category', { max: 60 });
    if (!LISTING_CATEGORIES.includes(category)) throw httpError(400, 'Please choose a valid product category.');
    const unit = text(body.unit, 'Unit of measurement', { max: 20 });
    if (!LISTING_UNITS.includes(unit)) throw httpError(400, 'Please choose a valid unit of measurement.');
    const province = text(body.province, 'Province', { max: 40 });
    if (!ZAMBIAN_PROVINCES.includes(province)) throw httpError(400, 'Please choose a valid Zambian province.');

    const quantityKg = number(body.quantity, 'Available quantity', { min: 0, max: 1000000 });
    const minimumOrderQuantity = number(body.minimumOrder, 'Minimum order quantity', { min: 0.01, max: 1000000 });
    if (quantityKg > 0 && minimumOrderQuantity > quantityKg) {
        throw httpError(400, 'Minimum order quantity cannot exceed the available quantity.');
    }

    const rawHarvestDate = typeof body.harvestDate === 'string' ? body.harvestDate.trim() : '';
    let harvestDate = null;
    if (rawHarvestDate) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(rawHarvestDate) || Number.isNaN(Date.parse(`${rawHarvestDate}T00:00:00Z`))) {
            throw httpError(400, 'Please enter a valid harvest date.');
        }
        harvestDate = rawHarvestDate;
    }

    const deliveryAvailable = body.deliveryAvailable === true
        || body.deliveryAvailable === 'true'
        || body.deliveryAvailable === 'on'
        || body.deliveryAvailable === '1';
    if (body.deliveryAvailable !== undefined && !deliveryAvailable
        && ![false, 'false', '0', ''].includes(body.deliveryAvailable)) {
        throw httpError(400, 'Please choose a valid delivery availability.');
    }

    return {
        farmerName: user.name,
        location: text(body.location, 'Farm or collection location', { max: 100 }),
        product: text(body.product, 'Product name', { max: 100 }),
        category,
        description: text(body.description, 'Product description', { min: 10, max: 2000 }),
        unit,
        quantityKg,
        minimumOrderQuantity,
        pricePerKg: number(body.price, 'Price per unit', { min: 0.01, max: 1000000 }),
        province,
        imageUrls,
        harvestDate,
        deliveryAvailable,
    };
}

function optionalQueryNumber(url, key, { min = 0, max = 1000000 } = {}) {
    const raw = url.searchParams.get(key);
    if (raw === null || raw === '') return null;
    return number(raw, key, { min, max });
}

function queryBoolean(url, key) {
    const value = url.searchParams.get(key);
    if (value === null || value === 'false' || value === '0') return false;
    if (value === 'true' || value === '1') return true;
    throw httpError(400, `${key} must be true or false.`);
}

function catalogFilters(url) {
    const query = url.searchParams.get('q') || '';
    if (query.length > 100) throw httpError(400, 'Search text is too long.');

    const category = url.searchParams.get('category') || '';
    if (category && !LISTING_CATEGORIES.includes(category)) throw httpError(400, 'Please choose a valid product category.');
    const province = url.searchParams.get('province') || '';
    if (province && !ZAMBIAN_PROVINCES.includes(province)) throw httpError(400, 'Please choose a valid Zambian province.');
    const sort = url.searchParams.get('sort') || 'newest';
    if (!['price-low', 'price-high', 'newest', 'rating'].includes(sort)) {
        throw httpError(400, 'Please choose a valid sort order.');
    }
    const page = number(url.searchParams.get('page') || '1', 'Page', { min: 1, max: 1000000 });
    const pageSize = number(url.searchParams.get('pageSize') || '12', 'Page size', { min: 1, max: 48 });
    const priceMin = optionalQueryNumber(url, 'priceMin');
    const priceMax = optionalQueryNumber(url, 'priceMax');
    const quantityMin = optionalQueryNumber(url, 'quantityMin');
    const quantityMax = optionalQueryNumber(url, 'quantityMax');
    if (priceMin !== null && priceMax !== null && priceMin > priceMax) {
        throw httpError(400, 'Minimum price cannot exceed maximum price.');
    }
    if (quantityMin !== null && quantityMax !== null && quantityMin > quantityMax) {
        throw httpError(400, 'Minimum quantity cannot exceed maximum quantity.');
    }

    const minRating = optionalQueryNumber(url, 'minRating', { min: 1, max: 5 });
    if (minRating !== null && !Number.isInteger(minRating)) throw httpError(400, 'Minimum seller rating must be a whole number from 1 to 5.');
    return {
        query,
        category: category || null,
        province: province || null,
        sort,
        page,
        pageSize,
        offset: (page - 1) * pageSize,
        priceMin,
        priceMax,
        quantityMin,
        quantityMax,
        minRating,
        verifiedOnly: queryBoolean(url, 'verified'),
        deliveryOnly: queryBoolean(url, 'delivery'),
    };
}

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
/* Notifications (shown on the site, and emailed if email is set up)   */
/* ------------------------------------------------------------------ */

async function sendEmail(to, subject, body) {
    if (!EMAIL_API_KEY || !EMAIL_FROM) return; // email not set up: skip quietly
    try {
        const response = await fetch(EMAIL_API_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${EMAIL_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, text: body }),
        });
        if (!response.ok) console.error(`Email service answered ${response.status}`);
    } catch (error) {
        console.error('Could not send email:', error.message); // never let email problems break the site
    }
}

// Never throws: the thing the person just did has already worked, so a notification problem must not undo it
async function notify(userId, message, { link = '/account.html', email = true } = {}) {
    try {
        const text = message.slice(0, 1000);
        await store.addNotification(crypto.randomUUID(), userId, text, link);
        if (!email) return;

        const recipient = await store.findUserById(userId);
        if (!recipient) return;
        const subject = `AgriLink: ${text}`.replace(/\s+/g, ' ').slice(0, 120);
        // Emails never include other people's phone numbers; those stay on the account page
        sendEmail(
            recipient.email,
            subject,
            `Hello ${recipient.name},\n\n${text}\n\nOpen your account: ${SITE_URL}${link}\n\nAgriLink Zambia`
        );
    } catch (error) {
        console.error('Could not save a notification:', error.message);
    }
}

const withoutIds = ({ userId, farmerId, transporterId, ...rest }) => rest; // never send other people's internal ids

const routes = {
    'GET /api/me': async (req, res) => {
        const user = await currentUser(req);
        const unread = user ? await store.unreadCount(user.id) : 0;
        sendJSON(res, 200, { user: user ? { name: user.name, role: user.role } : null, unread });
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

        const user = {
            id: crypto.randomUUID(),
            role,
            name,
            email: userEmail,
            phone: userPhone,
            phoneKey: normalisePhone(userPhone),
            location,
            passwordHash: await hashPassword(password),
        };
        if (!(await store.createUser(user))) {
            throw httpError(409, 'An account with that email already exists.');
        }

        const token = await createSession(user.id);
        sendJSON(res, 201, {
            ok: true,
            message: 'Registration successful. Your account has been created.',
            redirect: '/account.html?registration=success',
        }, {
            'Set-Cookie': sessionCookie(token, SESSION_MS / 1000),
        });
    },

    'POST /api/login': async (req, res) => {
        rateLimit(req);
        const body = await readBody(req);
        const username = text(body.username, 'Email or phone number', { max: 254 });
        const password = text(body.password, 'Password', { max: 200 });

        const phoneKey = normalisePhone(username);
        const user = await store.findUserByLogin(username.toLowerCase(), phoneKey.length >= 7 ? phoneKey : '');

        const valid = await verifyPassword(password, user ? user.passwordHash : DUMMY_HASH);
        if (!user || !valid) throw httpError(401, 'Incorrect email, phone number or password.');

        await store.deleteExpiredSessions(); // tidy up old logins now and then
        const token = await createSession(user.id);
        sendJSON(res, 200, {
            ok: true,
            message: `Login successful. Welcome back, ${user.name}.`,
            redirect: '/account.html?login=success',
        }, {
            'Set-Cookie': sessionCookie(token, SESSION_MS / 1000),
        });
    },

    'POST /api/logout': async (req, res) => {
        const token = parseCookies(req.headers.cookie).sid;
        if (token) await store.deleteSession(hashToken(token));
        sendJSON(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    },

    // Farmers: list produce for sale
    'POST /api/listings': async (req, res) => {
        const user = await requireRole(req, ['farmer']);
        const body = await readBody(req, MAX_LISTING_BODY_BYTES);
        const { imageUrls, savedPaths } = await prepareListingImages(body);
        try {
            await store.createListing({
                id: crypto.randomUUID(),
                userId: user.id,
                ...listingFields(body, user, imageUrls),
            });
        } catch (error) {
            await Promise.all(savedPaths.map((image) =>
                fs.promises.unlink(path.join(PUBLIC_DIR, image.slice(1))).catch((cleanupError) => {
                    console.error('Could not remove an unsaved listing image:', cleanupError.message);
                })
            ));
            throw error;
        }
        sendJSON(res, 201, { ok: true, message: 'Thank you! Your listing has been saved.' });
    },

    // Buyers: bulk orders
    'POST /api/orders': async (req, res) => {
        const user = await requireRole(req, ['buyer']);
        const body = await readBody(req);
        const quantityKg = number(body.quantity, 'Quantity', { min: 0.01, max: 1000000 });
        const buyerName = text(body.name, 'Your name or business', { max: 100 });
        const listingId = typeof body.listingId === 'string' ? body.listingId.trim() : '';
        const paymentMethod = body.paymentMethod;
        if (paymentMethod !== 'mobile_money' && paymentMethod !== 'paypal') {
            throw httpError(400, 'Please choose a valid payment method.');
        }
        let mobileMoneyProvider = null;
        if (paymentMethod === 'mobile_money') {
            mobileMoneyProvider = body.mobileMoneyProvider;
            if (!['mtn', 'airtel', 'zamtel'].includes(mobileMoneyProvider)) {
                throw httpError(400, 'Please choose a valid Mobile Money network.');
            }
        }

        // An order can be linked to one farmer's listing, or be a general request
        let listing = null;
        if (listingId) {
            listing = await store.getListing(listingId);
            if (!listing) throw httpError(404, 'That listing is no longer available.');
            if (listing.userId === user.id) throw httpError(400, 'You cannot order from your own listing.');
            if (listing.quantityKg <= 0) throw httpError(409, 'That listing is sold out.');
            if (quantityKg > listing.quantityKg) {
                throw httpError(400, `Only ${listing.quantityKg} ${listing.unit} is available in this listing.`);
            }
            if (quantityKg < listing.minimumOrderQuantity) {
                throw httpError(400, `The minimum order for this listing is ${listing.minimumOrderQuantity} ${listing.unit}.`);
            }
        }
        const product = listing ? listing.product : text(body.product, 'Product needed', { max: 100 });

        await store.createOrder({
            id: crypto.randomUUID(),
            userId: user.id,
            buyerName,
            phone: phone(body.phone),
            product,
            quantityKg,
            address: text(body.address, 'Delivery address', { max: 300 }),
            listingId: listing ? listing.id : null,
            farmerId: listing ? listing.userId : null,
            sellerName: listing ? listing.farmerName : null,
            sellerLocation: listing ? listing.location : null,
            pricePerKg: listing ? listing.pricePerKg : null,
            unit: listing ? listing.unit : 'kg',
            paymentMethod,
            mobileMoneyProvider,
            status: listing ? 'pending' : 'open',
        });

        const confirmation = listing
            ? `Your order for ${quantityKg} ${listing.unit} of ${listing.product} has been sent to ${listing.farmerName}. Your payment preference is saved; arrange payment after the farmer confirms the order.`
            : `Your request for ${quantityKg} kg of ${product} has been received. Your payment preference is saved; arrange payment after the seller confirms the order. You can follow it on your account page.`;
        await notify(user.id, confirmation, { link: '/account.html#notifications' });

        if (listing) {
            await notify(listing.userId, `New order: ${quantityKg} ${listing.unit} of ${listing.product} from ${buyerName}.`,
                { link: '/account.html#orders-received' });
        }
        sendJSON(res, 201, {
            ok: true,
            message: confirmation,
            redirect: '/account.html#notifications',
        });
    },

    // Farmers: accept or decline an order made on one of their listings
    'POST /api/orders/respond': async (req, res) => {
        const user = await requireRole(req, ['farmer']);
        const body = await readBody(req);
        const id = text(body.id, 'Order', { max: 60 });
        const decision = body.decision;
        if (decision !== 'accept' && decision !== 'decline') throw httpError(400, 'Please choose accept or decline.');

        const outcome = await store.respondToOrder(id, user.id, decision);
        if (outcome.result === 'not_found') throw httpError(404, 'Order not found.');
        if (outcome.result === 'answered') throw httpError(409, 'You have already responded to this order.');
        if (outcome.result === 'insufficient') {
            throw httpError(409, 'There is not enough left in this listing to accept this order.');
        }

        const { order } = outcome;
        await notify(order.userId,
            `${order.sellerName || 'The farmer'} ${decision === 'accept' ? 'accepted' : 'declined'} your order for ${order.quantityKg} ${order.unit} of ${order.product}.`,
            { link: '/account.html#my-orders' });
        sendJSON(res, 200, { ok: true, message: decision === 'accept' ? 'Order accepted.' : 'Order declined.' });
    },

    // Anyone: request a transporter
    'POST /api/transport-requests': async (req, res) => {
        const user = await requireRole(req, ['farmer', 'buyer']);
        const body = await readBody(req);
        const job = {
            id: crypto.randomUUID(),
            userId: user.id,
            pickup: text(body.pickup, 'Pickup location', { max: 200 }),
            destination: text(body.destination, 'Destination', { max: 200 }),
            produce: text(body.produce, 'Type of produce', { max: 100 }),
            weightKg: number(body.weight, 'Weight', { min: 1, max: 1000000 }),
            date: futureDate(body.date, 'Delivery date'),
            orderId: typeof body.orderId === 'string' && body.orderId.trim() ? body.orderId.trim() : null,
        };
        const outcome = await store.createTransport(job);
        if (outcome.result === 'not_found') {
            throw httpError(404, 'That accepted order was not found on your account.');
        }
        if (outcome.result === 'not_accepted') {
            throw httpError(409, 'Transport can be requested only for an accepted order.');
        }
        if (outcome.result === 'already_requested') {
            throw httpError(409, 'A delivery request already exists for that order.');
        }

        // Tell the transporters on the site only, so their inboxes don't fill up
        const transporters = await store.transporterIds(user.id);
        await Promise.all(transporters.map((id) => notify(
            id,
            `New delivery job: ${job.produce} from ${job.pickup} to ${job.destination}.`,
            { link: '/account.html#jobs-available', email: false }
        )));
        sendJSON(res, 201, { ok: true, message: 'Thank you! Your transport request has been sent. A transporter can now accept it, and you can follow it on your account page.' });
    },

    // Transporters: take on an open delivery job
    'POST /api/transport-requests/accept': async (req, res) => {
        const user = await requireUser(req);
        if (user.role !== 'transporter') throw httpError(403, 'Only transporters can accept delivery jobs.');
        const body = await readBody(req);
        const id = text(body.id, 'Job', { max: 60 });

        const outcome = await store.acceptTransport(id, user);
        if (outcome.result === 'not_found') throw httpError(404, 'Job not found.');
        if (outcome.result === 'own') throw httpError(400, 'You cannot accept your own request.');
        if (outcome.result === 'taken') throw httpError(409, 'This job has already been taken or cancelled.');

        const { job } = outcome;
        await notify(job.userId,
            `${user.name} accepted your delivery from ${job.pickup} to ${job.destination}. Their phone number is on your account page.`,
            { link: '/account.html#my-transport' });
        sendJSON(res, 200, { ok: true, message: 'Job accepted. The contact details are on your account page.' });
    },

    // Transporters: mark one of their accepted jobs as delivered
    'POST /api/transport-requests/deliver': async (req, res) => {
        const user = await requireRole(req, ['transporter']);
        const body = await readBody(req);
        const id = text(body.id, 'Job', { max: 60 });

        const outcome = await store.deliverTransport(id, user.id);
        if (outcome.result === 'not_found') throw httpError(404, 'Job not found.');
        if (outcome.result === 'not_accepted') throw httpError(409, 'This job is not waiting for delivery.');

        const { job } = outcome;
        await notify(job.userId,
            `Your delivery from ${job.pickup} to ${job.destination} was marked as delivered by ${user.name}.`,
            { link: '/account.html#my-transport' });
        sendJSON(res, 200, { ok: true, message: 'Marked as delivered.' });
    },

    // Whoever asked for the transport: cancel a request nobody has taken yet
    'POST /api/transport-requests/cancel': async (req, res) => {
        const user = await requireRole(req, ['farmer', 'buyer']);
        const body = await readBody(req);
        const id = text(body.id, 'Request', { max: 60 });

        const outcome = await store.cancelTransport(id, user.id);
        if (outcome === 'not_found') throw httpError(404, 'Request not found.');
        if (outcome === 'taken') {
            throw httpError(409, 'A transporter has already accepted this request, so please contact them to cancel.');
        }
        sendJSON(res, 200, { ok: true, message: 'Request cancelled.' });
    },

    // Everything the logged-in person has done (for the My Account page)
    'GET /api/my-activity': async (req, res) => {
        const user = await requireUser(req);
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

        // Seven separate questions to the database, asked at the same time
        const [listings, orders, ordersReceived, requests, notifications, available, taken] = await Promise.all([
            store.userListings(user.id),
            store.userOrders(user.id),
            store.ordersReceived(user.id),
            store.userTransportRequests(user.id),
            store.listNotifications(user.id, 30), // newest first
            user.role === 'transporter' ? store.jobsAvailable(user.id, yesterday) : [],
            store.transporterJobs(user.id),
        ]);

        sendJSON(res, 200, {
            user: {
                name: user.name,
                role: user.role,
                email: user.email,
                phone: user.phone,
                location: user.location,
                createdAt: user.createdAt,
            },
            listings: listings.map(withoutIds),
            orders: orders.map(withoutIds),
            ordersReceived: ordersReceived.map(withoutIds),
            transportRequests: requests.map(withoutIds),
            notifications: notifications.map(withoutIds),
            // Open jobs show only what is needed to decide: no names or phone numbers yet
            jobsAvailable: available.map(({ id, pickup, destination, produce, weightKg, date, createdAt }) => (
                { id, pickup, destination, produce, weightKg, date, createdAt }
            )),
            // Jobs this transporter accepted, with the requester's contact details
            myJobs: taken.map((job) => ({
                id: job.id,
                pickup: job.pickup,
                destination: job.destination,
                produce: job.produce,
                weightKg: job.weightKg,
                date: job.date,
                status: job.status,
                acceptedAt: job.acceptedAt,
                deliveredAt: job.deliveredAt,
                requesterName: job.requesterName || '',
                requesterPhone: job.requesterPhone || '',
            })),
        });
    },

    'GET /api/admin/overview': async (req, res) => {
        await requireRole(req, ['admin']);
        sendJSON(res, 200, await store.adminOverview());
    },

    'POST /api/admin/farmers/verify': async (req, res) => {
        await requireRole(req, ['admin']);
        const body = await readBody(req);
        const id = text(body.id, 'Farmer', { max: 60 });
        if (typeof body.verified !== 'boolean') {
            throw httpError(400, 'Verification status must be true or false.');
        }
        if (!(await store.verifyFarmer(id, body.verified))) throw httpError(404, 'Farmer not found.');
        sendJSON(res, 200, {
            ok: true,
            message: body.verified ? 'Farmer verified.' : 'Farmer verification removed.',
        });
    },

    // Farmers: remove one of their own listings
    'POST /api/listings/delete': async (req, res) => {
        const user = await requireRole(req, ['farmer']);
        const body = await readBody(req);
        const id = text(body.id, 'Listing', { max: 60 });

        const result = await store.deleteListing(id, user.id); // only your own
        if (!result) throw httpError(404, 'Listing not found.');
        await removeListingUploads(result.imageUrls);

        // Orders still waiting on this listing can no longer be answered
        for (const order of result.cancelledOrders) {
            await notify(order.userId,
                `Your order for ${order.quantityKg} ${order.unit} of ${order.product} was cancelled because the farmer removed the listing.`,
                { link: '/account.html#my-orders' });
        }
        sendJSON(res, 200, { ok: true, message: 'Listing deleted.' });
    },

    // Farmers: update one of their own product listings
    'POST /api/listings/update': async (req, res) => {
        const user = await requireRole(req, ['farmer']);
        const body = await readBody(req, MAX_LISTING_BODY_BYTES);
        const id = text(body.id, 'Listing', { max: 60 });
        const current = await store.getListing(id);
        if (!current || current.userId !== user.id) throw httpError(404, 'Listing not found.');
        const { imageUrls, savedPaths } = await prepareListingImages(body, current.imageUrls);
        try {
            const changes = listingFields(body, user, imageUrls);
            if (!(await store.updateListing(id, user.id, changes))) throw httpError(404, 'Listing not found.');
        } catch (error) {
            await removeListingUploads(savedPaths);
            throw error;
        }
        await removeListingUploads(current.imageUrls.filter((image) => !imageUrls.includes(image)));
        sendJSON(res, 200, { ok: true, message: 'Listing updated.' });
    },

    // Mark all of my notifications as read (the account page calls this once it has shown them)
    'POST /api/notifications/read': async (req, res) => {
        const user = await requireUser(req);
        await store.markAllRead(user.id);
        sendJSON(res, 200, { ok: true });
    },

    'POST /api/orders/confirm-delivery': async (req, res) => {
        const user = await requireRole(req, ['buyer']);
        const body = await readBody(req);
        const id = text(body.id, 'Order', { max: 60 });
        const outcome = await store.confirmOrderDelivery(id, user.id);
        if (outcome.result === 'not_found') throw httpError(404, 'Order not found.');
        if (outcome.result === 'not_delivered') {
            throw httpError(409, 'You can confirm an order only after its delivery is marked delivered.');
        }
        if (outcome.result === 'ok' && outcome.order.farmerId) {
            await notify(outcome.order.farmerId,
                `The buyer confirmed delivery of ${outcome.order.quantityKg} ${outcome.order.unit} of ${outcome.order.product}.`,
                { link: '/account.html#orders-received' });
        }
        sendJSON(res, 200, { ok: true, message: 'Delivery confirmed. You can now review the farmer.' });
    },

    'POST /api/orders/review': async (req, res) => {
        const user = await requireRole(req, ['buyer']);
        const body = await readBody(req);
        const orderId = text(body.orderId, 'Order', { max: 60 });
        const rating = number(body.rating, 'Rating', { min: 1, max: 5 });
        if (!Number.isInteger(rating)) throw httpError(400, 'Rating must be a whole number from 1 to 5.');
        const commentText = body.comment ? text(body.comment, 'Review', { max: 1000 }) : null;
        const result = await store.createFarmerReview({
            id: crypto.randomUUID(),
            orderId,
            buyerId: user.id,
            rating,
            commentText,
        });
        if (result === 'already_reviewed') throw httpError(409, 'You have already reviewed this order.');
        if (result === 'not_eligible') {
            throw httpError(409, 'Only a confirmed delivery from a farmer can be reviewed.');
        }
        sendJSON(res, 201, { ok: true, message: 'Thank you. Your review has been saved.' });
    },

    // Anyone (no login needed): send a message to the AgriLink team
    'POST /api/contact': async (req, res) => {
        rateLimit(req, 5, undefined, 'contact');
        const body = await readBody(req);
        const topic = text(body.subject, 'Subject', { max: 40 });
        if (!CONTACT_TOPICS.includes(topic)) throw httpError(400, 'Please choose a subject from the list.');
        const contactMessage = {
            id: crypto.randomUUID(),
            name: text(body.name, 'Your name', { max: 100 }),
            email: email(body.email),
            subject: topic,
            message: text(body.message, 'Message', { min: 10, max: 2000 }),
        };
        await store.addContactMessage(contactMessage);

        if (!CONTACT_EMAIL) {
            console.warn('CONTACT_EMAIL is not configured; the contact message was saved without an email notification.');
        } else if (!EMAIL_API_KEY || !EMAIL_FROM) {
            console.warn('The contact message was saved, but email notification requires EMAIL_API_KEY and EMAIL_FROM.');
        } else {
            await sendEmail(
                CONTACT_EMAIL,
                `New AgriLink contact message: ${topic}`,
                `From: ${contactMessage.name} <${contactMessage.email}>\nSubject: ${topic}\n\n${contactMessage.message}`
            );
        }
        sendJSON(res, 201, { ok: true, message: 'Thank you! We have received your message and will reply soon.' });
    },

    // One listing, so the order form can show what is being ordered
    'GET /api/listing': async (req, res, url) => {
        const id = url.searchParams.get('id') || '';
        const listing = await store.getListing(id);
        if (!listing) throw httpError(404, 'That listing is no longer available.');
        const { userId, ...publicFields } = listing;
        const reviews = await store.publicListingReviews(id);
        sendJSON(res, 200, { listing: publicFields, reviews });
    },

    // Public marketplace catalog with bound filters and database pagination
    'GET /api/listings': async (req, res, url) => {
        const filters = catalogFilters(url);
        const result = await store.publicListings(filters);
        const listings = result.listings.map(({ userId, ...publicFields }) => publicFields);
        sendJSON(res, 200, {
            listings,
            pagination: {
                page: filters.page,
                pageSize: filters.pageSize,
                total: result.total,
                totalPages: Math.ceil(result.total / filters.pageSize),
            },
        });
    },

    // Public farmer directory, grouped by account without exposing account IDs
    'GET /api/farmers': async (req, res) => {
        sendJSON(res, 200, { farmers: await store.publicFarmers() });
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
        const url = new URL(req.url, 'http://localhost');
        const { pathname } = url;

        if (pathname.startsWith('/api/')) {
            const handler = routes[`${req.method} ${pathname}`];
            if (!handler) throw httpError(404, 'Not found.');
            return await handler(req, res, url);
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

function explainDatabaseProblem(error) {
    const message = String(error.message || error);
    if (message.includes('ORA-01017')) return 'The user name or password in .env is wrong (DB_USER and DB_PASSWORD).';
    if (message.includes('bad decrypt') || message.includes('NJS-505')) return 'The wallet password in .env is wrong (DB_WALLET_PASSWORD).';
    if (message.includes('NJS-517') || message.includes('NJS-530')) return 'The connection name in .env (DB_CONNECTION_STRING) is not in wallet/tnsnames.ora.';
    if (message.includes('ORA-00942')) return 'A table is missing. Run: node setup-database.js';
    if (message.includes('Missing in your .env')) return 'Add the missing line to your .env file.';
    return 'Check that the database is started in the Oracle console (free databases stop after 7 days of no use).';
}

(async () => {
    try {
        await db.start();
        await db.execute('SELECT 1 AS ok FROM dual'); // proves the connection works before we accept visitors
    } catch (error) {
        console.error('Could not connect to the Oracle database:', error.message);
        console.error('Hint:', explainDatabaseProblem(error));
        process.exit(1);
    }

    server.listen(PORT, () => {
        console.log(`AgriLink Zambia is running at http://localhost:${PORT}`);
        console.log('Connected to the Oracle database.');
    });
})();

// Ctrl + C: close the database connections neatly before stopping
process.on('SIGINT', async () => {
    server.close();
    await db.stop();
    process.exit(0);
});
