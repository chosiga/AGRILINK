'use strict';

/*
 * AgriLink data layer: every SQL statement lives in this file.
 * server.js asks for data here and never writes SQL itself.
 *
 * Each function hands back plain objects shaped the same way the website already expects
 * (userId, quantityKg, createdAt ...), so the pages did not need to change.
 *
 * Two safety rules used throughout:
 *   - values always go in as :binds, never glued into the SQL text (this blocks SQL injection)
 *   - anything that must not happen twice (accepting a job, answering an order) is done with one
 *     conditional UPDATE, so two people clicking at the same moment cannot both win
 */

const toIso = (value) => {
    if (value === null || value === undefined) return null;
    return (value instanceof Date ? value : new Date(value)).toISOString();
};

// Thrown inside a transaction to undo everything it did so far
class Rollback extends Error {}

// "id, user_id, ..." with an optional table alias in front: cols('o', ['id', 'user_id']) -> "o.id, o.user_id"
const cols = (alias, names) => names.map((name) => (alias ? `${alias}.${name}` : name)).join(', ');

const USER = ['id', 'user_role', 'name', 'email', 'phone', 'phone_key', 'location', 'password_hash', 'is_verified', 'created_at'];
const LISTING = ['id', 'user_id', 'farmer_name', 'location', 'product', 'category', 'product_description', 'unit',
    'quantity_kg', 'minimum_order_quantity', 'price_per_kg', 'province', 'image_urls', 'harvest_date',
    'delivery_available', 'created_at', 'updated_at'];
const ORDER = ['id', 'user_id', 'buyer_name', 'phone', 'product', 'quantity_kg', 'address', 'listing_id', 'farmer_id',
    'seller_name', 'seller_location', 'price_per_kg', 'product_unit', 'payment_method', 'mobile_money_provider', 'payment_status',
    'payout_status', 'delivery_status', 'delivery_confirmed_at', 'status', 'created_at', 'responded_at'];
const TRANSPORT = ['id', 'user_id', 'pickup', 'destination', 'produce', 'weight_kg', 'status', 'transporter_id',
    'transporter_name', 'accepted_at', 'delivered_at', 'order_id', 'created_at'];
const NOTE = ['id', 'user_id', 'message', 'link', 'is_read', 'created_at'];

// Dates (no time of day) travel as plain text like 2026-12-01 so time zones can never shift them
const transportCols = (alias) => `${cols(alias, TRANSPORT)}, TO_CHAR(${alias ? `${alias}.` : ''}delivery_date, 'YYYY-MM-DD') AS delivery_day`;

/* ---------- database row  ->  the objects the website uses ---------- */

const userFrom = (r) => r && ({
    id: r.ID,
    role: r.USER_ROLE,
    name: r.NAME,
    email: r.EMAIL,
    phone: r.PHONE,
    phoneKey: r.PHONE_KEY,
    location: r.LOCATION,
    passwordHash: r.PASSWORD_HASH,
    isVerified: Number(r.IS_VERIFIED) === 1,
    createdAt: toIso(r.CREATED_AT),
});

const listingFrom = (r) => r && ({
    id: r.ID,
    userId: r.USER_ID,
    farmerName: r.FARMER_NAME,
    location: r.LOCATION,
    product: r.PRODUCT,
    category: r.CATEGORY,
    description: r.PRODUCT_DESCRIPTION,
    unit: r.UNIT,
    quantityKg: Number(r.QUANTITY_KG),
    minimumOrderQuantity: Number(r.MINIMUM_ORDER_QUANTITY),
    pricePerKg: Number(r.PRICE_PER_KG),
    province: r.PROVINCE,
    imageUrls: JSON.parse(r.IMAGE_URLS || '[]'),
    harvestDate: r.HARVEST_DAY || (r.HARVEST_DATE ? toIso(r.HARVEST_DATE).slice(0, 10) : null),
    deliveryAvailable: Number(r.DELIVERY_AVAILABLE) === 1,
    availabilityStatus: Number(r.QUANTITY_KG) > 0 ? 'available' : 'sold_out',
    farmerVerified: Number(r.FARMER_VERIFIED) === 1,
    farmerRating: Number(r.FARMER_RATING || 0),
    farmerReviewCount: Number(r.FARMER_REVIEW_COUNT || 0),
    createdAt: toIso(r.CREATED_AT),
    updatedAt: toIso(r.UPDATED_AT),
});

const orderFrom = (r) => r && ({
    id: r.ID,
    userId: r.USER_ID,
    buyerName: r.BUYER_NAME,
    phone: r.PHONE,
    product: r.PRODUCT,
    quantityKg: Number(r.QUANTITY_KG),
    address: r.ADDRESS,
    listingId: r.LISTING_ID,
    farmerId: r.FARMER_ID,
    sellerName: r.SELLER_NAME,
    sellerLocation: r.SELLER_LOCATION,
    pricePerKg: r.PRICE_PER_KG === null || r.PRICE_PER_KG === undefined ? null : Number(r.PRICE_PER_KG),
    unit: r.PRODUCT_UNIT || 'kg',
    paymentMethod: r.PAYMENT_METHOD,
    mobileMoneyProvider: r.MOBILE_MONEY_PROVIDER,
    paymentStatus: r.PAYMENT_STATUS,
    payoutStatus: r.PAYOUT_STATUS,
    deliveryStatus: r.DELIVERY_STATUS,
    deliveryConfirmedAt: toIso(r.DELIVERY_CONFIRMED_AT),
    reviewed: Number(r.REVIEW_COUNT || 0) > 0,
    status: r.STATUS,
    createdAt: toIso(r.CREATED_AT),
    respondedAt: toIso(r.RESPONDED_AT),
});

const transportFrom = (r) => r && ({
    id: r.ID,
    userId: r.USER_ID,
    pickup: r.PICKUP,
    destination: r.DESTINATION,
    produce: r.PRODUCE,
    weightKg: Number(r.WEIGHT_KG),
    date: r.DELIVERY_DAY,
    status: r.STATUS,
    transporterId: r.TRANSPORTER_ID,
    transporterName: r.TRANSPORTER_NAME,
    acceptedAt: toIso(r.ACCEPTED_AT),
    deliveredAt: toIso(r.DELIVERED_AT),
    orderId: r.ORDER_ID,
    createdAt: toIso(r.CREATED_AT),
});

const noteFrom = (r) => r && ({
    id: r.ID,
    userId: r.USER_ID,
    message: r.MESSAGE,
    link: r.LINK,
    read: Number(r.IS_READ) === 1,
    createdAt: toIso(r.CREATED_AT),
});

function createStore(db) {
    const one = async (sql, binds = {}) => (await db.execute(sql, binds)).rows[0] || null;
    const many = async (sql, binds = {}) => (await db.execute(sql, binds)).rows;

    /* ================================================================ */
    /* Users                                                            */
    /* ================================================================ */

    const findUserById = async (id) =>
        userFrom(await one(`SELECT ${cols('', USER)} FROM app_users WHERE id = :id`, { id }));

    // Sign in with an email, or with a phone number (phoneKey is '' when the text was not a phone number)
    async function findUserByLogin(email, phoneKey) {
        const byPhone = phoneKey ? ' OR phone_key = :phoneKey' : '';
        const binds = phoneKey ? { email, phoneKey } : { email };
        return userFrom(await one(
            `SELECT ${cols('', USER)} FROM app_users WHERE email = :email${byPhone} ORDER BY created_at FETCH FIRST 1 ROWS ONLY`,
            binds
        ));
    }

    // Returns false when that email is already registered
    async function createUser(user) {
        try {
            await db.execute(
                `INSERT INTO app_users (id, user_role, name, email, phone, phone_key, location, password_hash)
                 VALUES (:id, :role, :name, :email, :phone, :phoneKey, :location, :passwordHash)`,
                {
                    id: user.id,
                    role: user.role,
                    name: user.name,
                    email: user.email,
                    phone: user.phone,
                    phoneKey: user.phoneKey,
                    location: user.location,
                    passwordHash: user.passwordHash,
                }
            );
            return true;
        } catch (error) {
            if (error.errorNum === 1) return false; // ORA-00001: unique constraint (the email) already used
            throw error;
        }
    }

    const transporterIds = async (exceptUserId) =>
        (await many(`SELECT id FROM app_users WHERE user_role = 'transporter' AND id <> :userId`, { userId: exceptUserId }))
            .map((r) => r.ID);

    /* ================================================================ */
    /* Login sessions (only a scrambled copy of the token is stored)    */
    /* ================================================================ */

    const createSession = (tokenHash, userId, seconds) => db.execute(
        `INSERT INTO login_sessions (token_hash, user_id, expires_at)
         VALUES (:tokenHash, :userId, SYSTIMESTAMP + NUMTODSINTERVAL(:seconds, 'SECOND'))`,
        { tokenHash, userId, seconds }
    );

    const findSessionUser = async (tokenHash) => userFrom(await one(
        `SELECT ${cols('u', USER)}
           FROM login_sessions s
           JOIN app_users u ON u.id = s.user_id
          WHERE s.token_hash = :tokenHash AND s.expires_at > SYSTIMESTAMP`,
        { tokenHash }
    ));

    const deleteSession = (tokenHash) => db.execute(`DELETE FROM login_sessions WHERE token_hash = :tokenHash`, { tokenHash });
    const deleteExpiredSessions = () => db.execute(`DELETE FROM login_sessions WHERE expires_at <= SYSTIMESTAMP`);

    /* ================================================================ */
    /* Listings                                                         */
    /* ================================================================ */

    const createListing = (l) => db.execute(
        `INSERT INTO listings (
             id, user_id, farmer_name, location, product, category, product_description, unit,
             quantity_kg, minimum_order_quantity, price_per_kg, province, image_urls, harvest_date, delivery_available
         )
         VALUES (
             :id, :userId, :farmerName, :location, :product, :category, :description, :unit,
             :quantityKg, :minimumOrderQuantity, :pricePerKg, :province, :imageUrls,
             CASE WHEN :harvestDate IS NULL THEN NULL ELSE TO_DATE(:harvestDate, 'YYYY-MM-DD') END,
             :deliveryAvailable
         )`,
        {
            id: l.id,
            userId: l.userId,
            farmerName: l.farmerName,
            location: l.location,
            product: l.product,
            category: l.category,
            description: l.description,
            unit: l.unit,
            quantityKg: l.quantityKg,
            minimumOrderQuantity: l.minimumOrderQuantity,
            pricePerKg: l.pricePerKg,
            province: l.province,
            imageUrls: JSON.stringify(l.imageUrls),
            harvestDate: l.harvestDate,
            deliveryAvailable: l.deliveryAvailable ? 1 : 0,
        }
    );

    const listingJoins = `FROM listings l
        JOIN app_users u ON u.id = l.user_id
        LEFT JOIN (
            SELECT farmer_id, ROUND(AVG(rating), 1) AS farmer_rating, COUNT(*) AS farmer_review_count
              FROM farmer_reviews
             GROUP BY farmer_id
        ) r ON r.farmer_id = u.id`;
    const listingSelect = `${cols('l', LISTING)}, TO_CHAR(l.harvest_date, 'YYYY-MM-DD') AS harvest_day,
        u.is_verified AS farmer_verified, NVL(r.farmer_rating, 0) AS farmer_rating,
        NVL(r.farmer_review_count, 0) AS farmer_review_count`;

    const getListing = async (id) =>
        listingFrom(await one(
            `SELECT ${listingSelect} ${listingJoins} WHERE l.id = :id`,
            { id }
        ));

    const listingReviews = async (listingId) => (await many(
        `SELECT r.rating, r.comment_text, r.created_at, b.name AS buyer_name
           FROM farmer_reviews r
           JOIN app_users b ON b.id = r.buyer_id
          WHERE r.farmer_id = (SELECT user_id FROM listings WHERE id = :listingId)
          ORDER BY r.created_at DESC
          FETCH FIRST 20 ROWS ONLY`,
        { listingId }
    )).map((review) => ({
        rating: Number(review.RATING),
        comment: review.COMMENT_TEXT || '',
        createdAt: toIso(review.CREATED_AT),
        buyerName: review.BUYER_NAME,
    }));

    async function publicListings(filters) {
        const conditions = ['l.quantity_kg > 0'];
        const binds = {
            pageSize: filters.pageSize,
            offset: filters.offset,
        };
        if (filters.query) {
            conditions.push(`(
                LOWER(l.product) LIKE :search ESCAPE '\\'
                OR LOWER(l.category) LIKE :search ESCAPE '\\'
                OR LOWER(l.product_description) LIKE :search ESCAPE '\\'
                OR LOWER(l.farmer_name) LIKE :search ESCAPE '\\'
                OR LOWER(l.location) LIKE :search ESCAPE '\\'
                OR LOWER(l.province) LIKE :search ESCAPE '\\'
            )`);
            binds.search = `%${filters.query.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
        }
        if (filters.category) {
            conditions.push('l.category = :category');
            binds.category = filters.category;
        }
        if (filters.priceMin !== null) {
            conditions.push('l.price_per_kg >= :priceMin');
            binds.priceMin = filters.priceMin;
        }
        if (filters.priceMax !== null) {
            conditions.push('l.price_per_kg <= :priceMax');
            binds.priceMax = filters.priceMax;
        }
        if (filters.province) {
            conditions.push('l.province = :province');
            binds.province = filters.province;
        }
        if (filters.quantityMin !== null) {
            conditions.push('l.quantity_kg >= :quantityMin');
            binds.quantityMin = filters.quantityMin;
        }
        if (filters.quantityMax !== null) {
            conditions.push('l.quantity_kg <= :quantityMax');
            binds.quantityMax = filters.quantityMax;
        }
        if (filters.minRating !== null) {
            conditions.push('NVL(r.farmer_rating, 0) >= :minRating');
            binds.minRating = filters.minRating;
        }
        if (filters.verifiedOnly) conditions.push('u.is_verified = 1');
        if (filters.deliveryOnly) conditions.push('l.delivery_available = 1');

        const where = conditions.join(' AND ');
        const orderBy = {
            'price-low': 'l.price_per_kg ASC, l.created_at DESC',
            'price-high': 'l.price_per_kg DESC, l.created_at DESC',
            newest: 'l.created_at DESC',
            rating: 'NVL(r.farmer_rating, 0) DESC, NVL(r.farmer_review_count, 0) DESC, l.created_at DESC',
        }[filters.sort] || 'l.created_at DESC';
        const countBinds = { ...binds };
        delete countBinds.pageSize;
        delete countBinds.offset;
        const [count, rows] = await Promise.all([
            one(`SELECT COUNT(*) AS total ${listingJoins} WHERE ${where}`, countBinds),
            many(
                `SELECT ${listingSelect} ${listingJoins}
                  WHERE ${where}
                  ORDER BY ${orderBy}
                  OFFSET :offset ROWS FETCH NEXT :pageSize ROWS ONLY`,
                binds
            ),
        ]);
        return { listings: rows.map(listingFrom), total: Number(count.TOTAL) };
    }

    const publicListingReviews = listingReviews;

    const publicFarmers = async () => {
        const rows = await many(
            `SELECT u.id AS user_id, u.name AS farmer_name, u.location AS farmer_location,
                    u.is_verified AS farmer_verified,
                    NVL((SELECT ROUND(AVG(r.rating), 1) FROM farmer_reviews r WHERE r.farmer_id = u.id), 0) AS farmer_rating,
                    (SELECT COUNT(*) FROM farmer_reviews r WHERE r.farmer_id = u.id) AS farmer_review_count,
                    l.id AS listing_id, l.product, l.unit, l.quantity_kg, l.price_per_kg
               FROM app_users u
               LEFT JOIN listings l ON l.user_id = u.id AND l.quantity_kg > 0
              WHERE u.user_role = 'farmer'
              ORDER BY u.name, l.created_at DESC`
        );
        const farmers = new Map();
        rows.forEach((row) => {
            if (!farmers.has(row.USER_ID)) {
                farmers.set(row.USER_ID, {
                    name: row.FARMER_NAME,
                    location: row.FARMER_LOCATION,
                    verified: Number(row.FARMER_VERIFIED) === 1,
                    rating: Number(row.FARMER_RATING || 0),
                    reviewCount: Number(row.FARMER_REVIEW_COUNT || 0),
                    listings: [],
                });
            }
            if (row.LISTING_ID) {
                farmers.get(row.USER_ID).listings.push({
                    id: row.LISTING_ID,
                    product: row.PRODUCT,
                    unit: row.UNIT,
                    quantityKg: Number(row.QUANTITY_KG),
                    pricePerKg: Number(row.PRICE_PER_KG),
                });
            }
        });
        return [...farmers.values()];
    };

    const userListings = async (userId) => (await many(
        `SELECT ${cols('', LISTING)}, TO_CHAR(harvest_date, 'YYYY-MM-DD') AS harvest_day
           FROM listings WHERE user_id = :userId ORDER BY created_at DESC`,
        { userId }
    )).map(listingFrom);

    // true if it was the person's own listing and it was changed
    async function updateListing(id, userId, listing) {
        const result = await db.execute(
            `UPDATE listings
                SET location = :location, product = :product, category = :category,
                    product_description = :description, unit = :unit, quantity_kg = :quantityKg,
                    minimum_order_quantity = :minimumOrderQuantity, price_per_kg = :pricePerKg,
                    province = :province, image_urls = :imageUrls,
                    harvest_date = CASE WHEN :harvestDate IS NULL THEN NULL ELSE TO_DATE(:harvestDate, 'YYYY-MM-DD') END,
                    delivery_available = :deliveryAvailable, updated_at = SYSTIMESTAMP
              WHERE id = :id AND user_id = :userId`,
            {
                ...listing,
                imageUrls: JSON.stringify(listing.imageUrls),
                deliveryAvailable: listing.deliveryAvailable ? 1 : 0,
                id,
                userId,
            }
        );
        return result.rowsAffected === 1;
    }

    // Removes the listing and cancels orders still waiting on it. Returns null if it is not theirs,
    // otherwise the orders that were cancelled (so the buyers can be told).
    const deleteListing = (id, userId) => db.withTransaction(async (run) => {
        const owned = await run(
            `SELECT id, image_urls FROM listings WHERE id = :id AND user_id = :userId`,
            { id, userId }
        );
        if (owned.rows.length === 0) return null;

        const waiting = (await run(
            `SELECT ${cols('', ORDER)} FROM orders WHERE listing_id = :id AND status = 'pending'`, { id }
        )).rows.map(orderFrom);
        await run(`UPDATE orders SET status = 'cancelled' WHERE listing_id = :id AND status = 'pending'`, { id });
        await run(`DELETE FROM listings WHERE id = :id`, { id });
        return { cancelledOrders: waiting, imageUrls: JSON.parse(owned.rows[0].IMAGE_URLS || '[]') };
    });

    /* ================================================================ */
    /* Orders                                                           */
    /* ================================================================ */

    const createOrder = (o) => db.execute(
        `INSERT INTO orders (id, user_id, buyer_name, phone, product, quantity_kg, address, listing_id, farmer_id,
                             seller_name, seller_location, price_per_kg, product_unit, payment_method, mobile_money_provider,
                             payment_status, payout_status, status)
         VALUES (:id, :userId, :buyerName, :phone, :product, :quantityKg, :address, :listingId, :farmerId,
                 :sellerName, :sellerLocation, :pricePerKg, :productUnit, :paymentMethod, :mobileMoneyProvider,
                 'not_configured', 'not_configured', :status)`,
        {
            id: o.id,
            userId: o.userId,
            buyerName: o.buyerName,
            phone: o.phone,
            product: o.product,
            quantityKg: o.quantityKg,
            address: o.address,
            listingId: o.listingId ?? null,
            farmerId: o.farmerId ?? null,
            sellerName: o.sellerName ?? null,
            sellerLocation: o.sellerLocation ?? null,
            pricePerKg: o.pricePerKg ?? null,
            productUnit: o.unit || 'kg',
            paymentMethod: o.paymentMethod,
            mobileMoneyProvider: o.mobileMoneyProvider ?? null,
            status: o.status,
        }
    );

    // The buyer's own orders. The farmer's phone number appears only once the order is accepted.
    const userOrders = async (userId) => (await many(
        `SELECT ${cols('o', ORDER)}, f.phone AS seller_phone,
                (SELECT r.id FROM transport_requests r WHERE r.order_id = o.id) AS delivery_request_id,
                (SELECT COUNT(*) FROM farmer_reviews r WHERE r.order_id = o.id) AS review_count
           FROM orders o
           LEFT JOIN app_users f ON f.id = o.farmer_id AND o.status = 'accepted'
          WHERE o.user_id = :userId
          ORDER BY o.created_at DESC`,
        { userId }
    )).map((r) => ({
        ...orderFrom(r),
        sellerPhone: r.SELLER_PHONE || null,
        deliveryRequestId: r.DELIVERY_REQUEST_ID || null,
    }));

    const ordersReceived = async (farmerId) => (await many(
        `SELECT ${cols('o', ORDER)},
                (SELECT r.id FROM transport_requests r WHERE r.order_id = o.id) AS delivery_request_id
           FROM orders o WHERE o.farmer_id = :farmerId ORDER BY o.created_at DESC`,
        { farmerId }
    )).map((r) => ({ ...orderFrom(r), deliveryRequestId: r.DELIVERY_REQUEST_ID || null }));

    // A farmer accepts or declines. Returns { result: 'ok' | 'not_found' | 'answered' | 'insufficient', order }
    async function respondToOrder(id, farmerId, decision) {
        const newStatus = decision === 'accept' ? 'accepted' : 'declined';
        try {
            return await db.withTransaction(async (run) => {
                const row = (await run(
                    `SELECT ${cols('', ORDER)} FROM orders WHERE id = :id AND farmer_id = :farmerId`, { id, farmerId }
                )).rows[0];
                if (!row) return { result: 'not_found' };
                const order = orderFrom(row);
                if (order.status !== 'pending') return { result: 'answered' };

                // Only the first answer counts: the UPDATE succeeds only while the order is still pending
                const changed = await run(
                    `UPDATE orders SET status = :newStatus, responded_at = SYSTIMESTAMP WHERE id = :id AND status = 'pending'`,
                    { newStatus, id }
                );
                if (changed.rowsAffected !== 1) return { result: 'answered' };

                if (decision === 'accept') {
                    // Take the kilos out of the listing, but only if enough are left
                    const taken = await run(
                        `UPDATE listings SET quantity_kg = quantity_kg - :quantityKg
                          WHERE id = :listingId AND quantity_kg >= :quantityKg`,
                        { quantityKg: order.quantityKg, listingId: order.listingId }
                    );
                    if (taken.rowsAffected !== 1) throw new Rollback('insufficient');
                }
                return { result: 'ok', order };
            });
        } catch (error) {
            if (error instanceof Rollback) return { result: error.message }; // everything was undone
            throw error;
        }
    }

    /* ================================================================ */
    /* Transport requests                                               */
    /* ================================================================ */

    async function createTransport(j) {
        const insert = async (run) => {
            await run(
                `INSERT INTO transport_requests (id, user_id, pickup, destination, produce, weight_kg, delivery_date, order_id, status)
                 VALUES (:id, :userId, :pickup, :destination, :produce, :weightKg, TO_DATE(:deliveryDay, 'YYYY-MM-DD'), :orderId, 'open')`,
                {
                    id: j.id,
                    userId: j.userId,
                    pickup: j.pickup,
                    destination: j.destination,
                    produce: j.produce,
                    weightKg: j.weightKg,
                    deliveryDay: j.date,
                    orderId: j.orderId ?? null,
                }
            );
            if (j.orderId) {
                await run(
                    `UPDATE orders SET delivery_status = 'requested' WHERE id = :orderId`,
                    { orderId: j.orderId }
                );
            }
            return { result: 'ok' };
        };

        if (!j.orderId) {
            await insert((sql, binds) => db.execute(sql, binds));
            return { result: 'ok' };
        }

        try {
            return await db.withTransaction(async (run) => {
                const order = (await run(
                    `SELECT id, status FROM orders
                      WHERE id = :orderId AND (user_id = :userId OR farmer_id = :userId)
                      FOR UPDATE`,
                    { orderId: j.orderId, userId: j.userId }
                )).rows[0];
                if (!order) return { result: 'not_found' };
                if (order.STATUS !== 'accepted') return { result: 'not_accepted' };

                const existing = await run(
                    `SELECT id FROM transport_requests WHERE order_id = :orderId`,
                    { orderId: j.orderId }
                );
                if (existing.rows.length > 0) return { result: 'already_requested' };
                return insert(run);
            });
        } catch (error) {
            if (error.errorNum === 1) return { result: 'already_requested' };
            throw error;
        }
    }

    const getTransport = async (id) =>
        transportFrom(await one(`SELECT ${transportCols('')} FROM transport_requests WHERE id = :id`, { id }));

    // A transporter takes an open job. Returns { result: 'ok' | 'not_found' | 'own' | 'taken', job }
    async function acceptTransport(id, transporter) {
        const changed = await db.withTransaction(async (run) => {
            const result = await run(
                `UPDATE transport_requests
                    SET status = 'accepted', transporter_id = :transporterId, transporter_name = :transporterName,
                        accepted_at = SYSTIMESTAMP
                  WHERE id = :id AND status = 'open' AND user_id <> :transporterId`,
                { id, transporterId: transporter.id, transporterName: transporter.name }
            );
            if (result.rowsAffected === 1) {
                await run(
                    `UPDATE orders SET delivery_status = 'in_transit'
                      WHERE id = (SELECT order_id FROM transport_requests WHERE id = :id)
                        AND delivery_status = 'requested'`,
                    { id }
                );
            }
            return result;
        });
        if (changed.rowsAffected === 1) return { result: 'ok', job: await getTransport(id) };

        const job = await getTransport(id);
        if (!job) return { result: 'not_found' };
        if (job.userId === transporter.id) return { result: 'own' };
        return { result: 'taken' };
    }

    // Returns { result: 'ok' | 'not_found' | 'not_accepted', job }
    async function deliverTransport(id, transporterId) {
        const changed = await db.withTransaction(async (run) => {
            const result = await run(
                `UPDATE transport_requests SET status = 'delivered', delivered_at = SYSTIMESTAMP
                  WHERE id = :id AND transporter_id = :transporterId AND status = 'accepted'`,
                { id, transporterId }
            );
            if (result.rowsAffected === 1) {
                await run(
                    `UPDATE orders SET delivery_status = 'delivered'
                      WHERE id = (SELECT order_id FROM transport_requests WHERE id = :id)
                        AND delivery_status = 'in_transit'`,
                    { id }
                );
            }
            return result;
        });
        if (changed.rowsAffected === 1) return { result: 'ok', job: await getTransport(id) };

        const job = await getTransport(id);
        if (!job || job.transporterId !== transporterId) return { result: 'not_found' };
        return { result: 'not_accepted' };
    }

    const getOrder = async (id) =>
        orderFrom(await one(`SELECT ${cols('', ORDER)} FROM orders WHERE id = :id`, { id }));

    async function confirmOrderDelivery(id, buyerId) {
        const changed = await db.execute(
            `UPDATE orders SET delivery_status = 'confirmed', delivery_confirmed_at = SYSTIMESTAMP
              WHERE id = :id AND user_id = :buyerId AND delivery_status = 'delivered'`,
            { id, buyerId }
        );
        if (changed.rowsAffected === 1) return { result: 'ok', order: await getOrder(id) };
        const order = await getOrder(id);
        if (!order || order.userId !== buyerId) return { result: 'not_found' };
        if (order.deliveryStatus === 'confirmed') return { result: 'confirmed', order };
        return { result: 'not_delivered' };
    }

    async function createFarmerReview(review) {
        try {
            const result = await db.execute(
                `INSERT INTO farmer_reviews (id, order_id, buyer_id, farmer_id, rating, comment_text)
                 SELECT :id, o.id, o.user_id, o.farmer_id, :rating, :commentText
                   FROM orders o
                  WHERE o.id = :orderId
                    AND o.user_id = :buyerId
                    AND o.status = 'accepted'
                    AND o.delivery_status = 'confirmed'
                    AND o.farmer_id IS NOT NULL`,
                review
            );
            return result.rowsAffected === 1 ? 'ok' : 'not_eligible';
        } catch (error) {
            if (error.errorNum === 1) return 'already_reviewed';
            throw error;
        }
    }

    const adminOverview = async () => {
        const [counts, farmers] = await Promise.all([
            one(`SELECT
                    (SELECT COUNT(*) FROM app_users) AS users,
                    (SELECT COUNT(*) FROM listings WHERE quantity_kg > 0) AS active_listings,
                    (SELECT COUNT(*) FROM orders) AS orders,
                    (SELECT COUNT(*) FROM transport_requests) AS transport_requests,
                    (SELECT COUNT(*) FROM app_users WHERE user_role = 'farmer' AND is_verified = 0) AS unverified_farmers
                   FROM dual`),
            many(`SELECT u.id, u.name, u.email, u.location, u.is_verified,
                         (SELECT COUNT(*) FROM listings l WHERE l.user_id = u.id AND l.quantity_kg > 0) AS active_listings
                    FROM app_users u
                   WHERE u.user_role = 'farmer'
                   ORDER BY u.is_verified, u.name
                   FETCH FIRST 100 ROWS ONLY`),
        ]);
        return {
            counts: {
                users: Number(counts.USERS),
                activeListings: Number(counts.ACTIVE_LISTINGS),
                orders: Number(counts.ORDERS),
                transportRequests: Number(counts.TRANSPORT_REQUESTS),
                unverifiedFarmers: Number(counts.UNVERIFIED_FARMERS),
            },
            farmers: farmers.map((farmer) => ({
                id: farmer.ID,
                name: farmer.NAME,
                email: farmer.EMAIL,
                location: farmer.LOCATION,
                verified: Number(farmer.IS_VERIFIED) === 1,
                activeListings: Number(farmer.ACTIVE_LISTINGS),
            })),
        };
    };

    const verifyFarmer = async (farmerId, verified) => {
        const result = await db.execute(
            `UPDATE app_users SET is_verified = :verified
              WHERE id = :farmerId AND user_role = 'farmer'`,
            { verified: verified ? 1 : 0, farmerId }
        );
        return result.rowsAffected === 1;
    };

    // The person who asked can cancel while it is still open. Returns 'ok' | 'not_found' | 'taken'
    async function cancelTransport(id, userId) {
        const changed = await db.execute(
            `UPDATE transport_requests SET status = 'cancelled' WHERE id = :id AND user_id = :userId AND status = 'open'`,
            { id, userId }
        );
        if (changed.rowsAffected === 1) return 'ok';
        const job = await getTransport(id);
        return job && job.userId === userId ? 'taken' : 'not_found';
    }

    // Requests the person made, with the transporter's phone once someone has taken the job
    const userTransportRequests = async (userId) => (await many(
        `SELECT ${transportCols('r')}, t.phone AS transporter_phone
           FROM transport_requests r
           LEFT JOIN app_users t ON t.id = r.transporter_id
          WHERE r.user_id = :userId
          ORDER BY r.created_at DESC`,
        { userId }
    )).map((r) => ({ ...transportFrom(r), transporterPhone: r.TRANSPORTER_PHONE || null }));

    // Open jobs a transporter can take: soonest delivery first, not their own, not already past
    const jobsAvailable = async (userId, earliestDay) => (await many(
        `SELECT ${transportCols('')}
           FROM transport_requests
          WHERE status = 'open' AND user_id <> :userId AND delivery_date >= TO_DATE(:earliestDay, 'YYYY-MM-DD')
          ORDER BY delivery_date, created_at
          FETCH FIRST 50 ROWS ONLY`,
        { userId, earliestDay }
    )).map(transportFrom);

    // Jobs this transporter took, with the requester's contact details
    const transporterJobs = async (transporterId) => (await many(
        `SELECT ${transportCols('r')}, q.name AS requester_name, q.phone AS requester_phone
           FROM transport_requests r
           JOIN app_users q ON q.id = r.user_id
          WHERE r.transporter_id = :transporterId
          ORDER BY r.created_at DESC`,
        { transporterId }
    )).map((r) => ({ ...transportFrom(r), requesterName: r.REQUESTER_NAME, requesterPhone: r.REQUESTER_PHONE }));

    /* ================================================================ */
    /* Notifications and contact messages                               */
    /* ================================================================ */

    const addNotification = (id, userId, message, link) => db.execute(
        `INSERT INTO notifications (id, user_id, message, link, is_read) VALUES (:id, :userId, :message, :link, 0)`,
        { id, userId, message, link }
    );

    const unreadCount = async (userId) =>
        Number((await one(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = :userId AND is_read = 0`, { userId })).N);

    const listNotifications = async (userId, rowLimit) => (await many(
        `SELECT ${cols('', NOTE)} FROM notifications WHERE user_id = :userId ORDER BY created_at DESC FETCH FIRST :rowLimit ROWS ONLY`,
        { userId, rowLimit }
    )).map(noteFrom);

    const markAllRead = (userId) =>
        db.execute(`UPDATE notifications SET is_read = 1 WHERE user_id = :userId AND is_read = 0`, { userId });

    const addContactMessage = (m) => db.execute(
        `INSERT INTO contact_messages (id, name, email, subject, message) VALUES (:id, :name, :email, :subject, :message)`,
        { id: m.id, name: m.name, email: m.email, subject: m.subject, message: m.message }
    );

    return {
        findUserById, findUserByLogin, createUser, transporterIds,
        createSession, findSessionUser, deleteSession, deleteExpiredSessions,
        createListing, getListing, publicListings, publicListingReviews, publicFarmers, userListings, updateListing, deleteListing,
        createOrder, userOrders, ordersReceived, respondToOrder,
        createTransport, getTransport, acceptTransport, deliverTransport, cancelTransport,
        userTransportRequests, jobsAvailable, transporterJobs,
        confirmOrderDelivery, createFarmerReview, adminOverview, verifyFarmer,
        addNotification, unreadCount, listNotifications, markAllRead, addContactMessage,
    };
}

module.exports = createStore;
