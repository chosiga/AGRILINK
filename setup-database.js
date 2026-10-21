'use strict';

/*
 * Creates the AgriLink tables in your Oracle database.
 *
 *   node setup-database.js
 *
 * It is safe to run more than once: missing tables, columns and constraints are added
 * without deleting or changing existing marketplace records.
 */

const db = require('./db');

// Text columns use CHAR so names with accents or other alphabets are not cut short.
// Times are stored with their time zone.
const TABLES = [
    {
        name: 'APP_USERS',
        sql: `CREATE TABLE app_users (
            id             VARCHAR2(36)       CONSTRAINT app_users_pk PRIMARY KEY,
            user_role      VARCHAR2(20)       NOT NULL
                                              CONSTRAINT app_users_role_ck CHECK (user_role IN ('farmer', 'buyer', 'transporter', 'admin')),
            name           VARCHAR2(100 CHAR) NOT NULL,
            email          VARCHAR2(254 CHAR) NOT NULL CONSTRAINT app_users_email_uq UNIQUE,
            phone          VARCHAR2(20)       NOT NULL,
            phone_key      VARCHAR2(20)       NOT NULL,
            location       VARCHAR2(100 CHAR) NOT NULL,
            password_hash  VARCHAR2(300)      NOT NULL,
            is_verified    NUMBER(1)           DEFAULT 0 NOT NULL
                                              CONSTRAINT app_users_verified_ck CHECK (is_verified IN (0, 1)),
            created_at     TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
        )`,
    },
    {
        name: 'LISTINGS',
        sql: `CREATE TABLE listings (
            id             VARCHAR2(36)       CONSTRAINT listings_pk PRIMARY KEY,
            user_id        VARCHAR2(36)       NOT NULL CONSTRAINT listings_user_fk REFERENCES app_users (id),
            farmer_name    VARCHAR2(100 CHAR) NOT NULL,
            location       VARCHAR2(100 CHAR) NOT NULL,
            product        VARCHAR2(100 CHAR) NOT NULL,
            category       VARCHAR2(60 CHAR) DEFAULT 'other-agricultural-products' NOT NULL,
            product_description VARCHAR2(2000 CHAR) DEFAULT 'Fresh agricultural products from a Zambian farm.' NOT NULL,
            unit           VARCHAR2(20 CHAR) DEFAULT 'kg' NOT NULL,
            quantity_kg    NUMBER(12, 2)      NOT NULL CONSTRAINT listings_qty_ck CHECK (quantity_kg >= 0),
            minimum_order_quantity NUMBER(12, 2) DEFAULT 1 NOT NULL,
            price_per_kg   NUMBER(12, 2)      NOT NULL CONSTRAINT listings_price_ck CHECK (price_per_kg >= 0),
            province       VARCHAR2(40 CHAR) DEFAULT 'Other' NOT NULL,
            image_urls     VARCHAR2(4000 CHAR) DEFAULT '[]' NOT NULL,
            harvest_date   DATE,
            delivery_available NUMBER(1) DEFAULT 0 NOT NULL,
            created_at     TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
            updated_at     TIMESTAMP WITH TIME ZONE
        )`,
    },
    {
        name: 'ORDERS',
        sql: `CREATE TABLE orders (
            id               VARCHAR2(36)       CONSTRAINT orders_pk PRIMARY KEY,
            user_id          VARCHAR2(36)       NOT NULL CONSTRAINT orders_user_fk REFERENCES app_users (id),
            buyer_name       VARCHAR2(100 CHAR) NOT NULL,
            phone            VARCHAR2(20)       NOT NULL,
            product          VARCHAR2(100 CHAR) NOT NULL,
            quantity_kg      NUMBER(12, 2)      NOT NULL CONSTRAINT orders_qty_ck CHECK (quantity_kg > 0),
            address          VARCHAR2(300 CHAR) NOT NULL,
            listing_id       VARCHAR2(36)       CONSTRAINT orders_listing_fk REFERENCES listings (id) ON DELETE SET NULL,
            farmer_id        VARCHAR2(36)       CONSTRAINT orders_farmer_fk REFERENCES app_users (id),
            seller_name      VARCHAR2(100 CHAR),
            seller_location  VARCHAR2(100 CHAR),
            price_per_kg     NUMBER(12, 2),
            product_unit     VARCHAR2(20 CHAR) DEFAULT 'kg' NOT NULL,
            payment_method   VARCHAR2(20 CHAR),
            mobile_money_provider VARCHAR2(20 CHAR),
            payment_status   VARCHAR2(20 CHAR) DEFAULT 'not_configured' NOT NULL
                                                CONSTRAINT orders_payment_status_ck CHECK (payment_status IN ('not_configured', 'pending', 'paid', 'failed', 'refunded')),
            payout_status    VARCHAR2(20 CHAR) DEFAULT 'not_configured' NOT NULL
                                                CONSTRAINT orders_payout_status_ck CHECK (payout_status IN ('not_configured', 'pending', 'paid')),
            delivery_status  VARCHAR2(20 CHAR) DEFAULT 'not_requested' NOT NULL
                                                CONSTRAINT orders_delivery_status_ck CHECK (delivery_status IN ('not_requested', 'requested', 'in_transit', 'delivered', 'confirmed')),
            delivery_confirmed_at TIMESTAMP WITH TIME ZONE,
            status           VARCHAR2(20)       DEFAULT 'open' NOT NULL
                                                CONSTRAINT orders_status_ck CHECK (status IN ('open', 'pending', 'accepted', 'declined', 'cancelled')),
            created_at       TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
            responded_at     TIMESTAMP WITH TIME ZONE
        )`,
    },
    {
        name: 'TRANSPORT_REQUESTS',
        sql: `CREATE TABLE transport_requests (
            id                VARCHAR2(36)       CONSTRAINT transport_pk PRIMARY KEY,
            user_id           VARCHAR2(36)       NOT NULL CONSTRAINT transport_user_fk REFERENCES app_users (id),
            pickup            VARCHAR2(200 CHAR) NOT NULL,
            destination       VARCHAR2(200 CHAR) NOT NULL,
            produce           VARCHAR2(100 CHAR) NOT NULL,
            weight_kg         NUMBER(12, 2)      NOT NULL CONSTRAINT transport_weight_ck CHECK (weight_kg > 0),
            delivery_date     DATE               NOT NULL,
            order_id          VARCHAR2(36),
            status            VARCHAR2(20)       DEFAULT 'open' NOT NULL
                                                 CONSTRAINT transport_status_ck CHECK (status IN ('open', 'accepted', 'delivered', 'cancelled')),
            transporter_id    VARCHAR2(36)       CONSTRAINT transport_transporter_fk REFERENCES app_users (id),
            transporter_name  VARCHAR2(100 CHAR),
            accepted_at       TIMESTAMP WITH TIME ZONE,
            delivered_at      TIMESTAMP WITH TIME ZONE,
            created_at        TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
        )`,
    },
    {
        name: 'NOTIFICATIONS',
        sql: `CREATE TABLE notifications (
            id          VARCHAR2(36)        CONSTRAINT notifications_pk PRIMARY KEY,
            user_id     VARCHAR2(36)        NOT NULL CONSTRAINT notifications_user_fk REFERENCES app_users (id),
            message     VARCHAR2(1000 CHAR) NOT NULL,
            link        VARCHAR2(200)       NOT NULL,
            is_read     NUMBER(1)           DEFAULT 0 NOT NULL CONSTRAINT notifications_read_ck CHECK (is_read IN (0, 1)),
            created_at  TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
        )`,
    },
    {
        name: 'CONTACT_MESSAGES',
        sql: `CREATE TABLE contact_messages (
            id          VARCHAR2(36)        CONSTRAINT contact_pk PRIMARY KEY,
            name        VARCHAR2(100 CHAR)  NOT NULL,
            email       VARCHAR2(254 CHAR)  NOT NULL,
            subject     VARCHAR2(40 CHAR)   NOT NULL,
            message     VARCHAR2(2000 CHAR) NOT NULL,
            created_at  TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
        )`,
    },
    {
        // Logins that survive a server restart. Only a scrambled copy of each token is stored.
        name: 'LOGIN_SESSIONS',
        sql: `CREATE TABLE login_sessions (
            token_hash  VARCHAR2(64)  CONSTRAINT login_sessions_pk PRIMARY KEY,
            user_id     VARCHAR2(36)  NOT NULL CONSTRAINT login_sessions_user_fk REFERENCES app_users (id),
            expires_at  TIMESTAMP WITH TIME ZONE NOT NULL,
            created_at  TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
        )`,
    },
    {
        name: 'FARMER_REVIEWS',
        sql: `CREATE TABLE farmer_reviews (
            id          VARCHAR2(36)       CONSTRAINT farmer_reviews_pk PRIMARY KEY,
            order_id    VARCHAR2(36)       NOT NULL,
            buyer_id    VARCHAR2(36)       NOT NULL CONSTRAINT farmer_reviews_buyer_fk REFERENCES app_users (id),
            farmer_id   VARCHAR2(36)       NOT NULL CONSTRAINT farmer_reviews_farmer_fk REFERENCES app_users (id),
            rating      NUMBER(1)          NOT NULL CONSTRAINT farmer_reviews_rating_ck CHECK (rating BETWEEN 1 AND 5),
            comment_text VARCHAR2(1000 CHAR),
            created_at  TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
            CONSTRAINT farmer_reviews_order_uq UNIQUE (order_id),
            CONSTRAINT farmer_reviews_order_fk FOREIGN KEY (order_id) REFERENCES orders (id)
        )`,
    },
];

// Indexes make searches fast, and Oracle likes one on every foreign key
const INDEXES = [
    ['APP_USERS_PHONE_IX', 'CREATE INDEX app_users_phone_ix ON app_users (phone_key)'],
    ['LISTINGS_USER_IX', 'CREATE INDEX listings_user_ix ON listings (user_id)'],
    ['ORDERS_USER_IX', 'CREATE INDEX orders_user_ix ON orders (user_id)'],
    ['ORDERS_FARMER_IX', 'CREATE INDEX orders_farmer_ix ON orders (farmer_id)'],
    ['ORDERS_LISTING_IX', 'CREATE INDEX orders_listing_ix ON orders (listing_id)'],
    ['TRANSPORT_ORDER_UQ', 'CREATE UNIQUE INDEX transport_order_uq ON transport_requests (order_id)'],
    ['TRANSPORT_USER_IX', 'CREATE INDEX transport_user_ix ON transport_requests (user_id)'],
    ['TRANSPORT_TRANSPORTER_IX', 'CREATE INDEX transport_transporter_ix ON transport_requests (transporter_id)'],
    ['TRANSPORT_OPEN_IX', 'CREATE INDEX transport_open_ix ON transport_requests (status, delivery_date)'],
    ['NOTIFICATIONS_USER_IX', 'CREATE INDEX notifications_user_ix ON notifications (user_id, is_read, created_at)'],
    ['LOGIN_SESSIONS_USER_IX', 'CREATE INDEX login_sessions_user_ix ON login_sessions (user_id)'],
    ['LOGIN_SESSIONS_EXPIRY_IX', 'CREATE INDEX login_sessions_expiry_ix ON login_sessions (expires_at)'],
    ['FARMER_REVIEWS_FARMER_IX', 'CREATE INDEX farmer_reviews_farmer_ix ON farmer_reviews (farmer_id, created_at)'],
    ['LISTINGS_CATEGORY_PRICE_IX', 'CREATE INDEX listings_category_price_ix ON listings (category, price_per_kg, created_at)'],
    ['LISTINGS_PROVINCE_IX', 'CREATE INDEX listings_province_ix ON listings (province, quantity_kg)'],
];

function explain(error) {
    const text = String(error.message || error);
    if (text.includes('ORA-01017')) return 'The user name or password in .env is wrong (DB_USER and DB_PASSWORD).';
    if (text.includes('bad decrypt') || text.includes('NJS-505')) return 'The wallet password in .env is wrong (DB_WALLET_PASSWORD).';
    if (text.includes('NJS-517') || text.includes('NJS-530')) return 'The connection name in .env (DB_CONNECTION_STRING) is not in wallet/tnsnames.ora.';
    if (text.includes('ORA-01031') || text.includes('ORA-01950')) {
        return 'AGRILINK does not have permission to create tables. Run the GRANT and QUOTA lines again as ADMIN.';
    }
    if (text.includes('Missing in your .env')) return 'Add the missing line to your .env file.';
    return null;
}

async function exists(kind, name) {
    const view = kind === 'table' ? 'user_tables' : 'user_indexes';
    const column = kind === 'table' ? 'table_name' : 'index_name';
    const result = await db.execute(`SELECT COUNT(*) AS n FROM ${view} WHERE ${column} = :name`, { name });
    return result.rows[0].N > 0;
}

async function ensureConstraint(name, sql) {
    const result = await db.execute(
        'SELECT COUNT(*) AS n FROM user_constraints WHERE constraint_name = :name',
        { name }
    );
    if (result.rows[0].N === 0) {
        await db.execute(sql);
        console.log(`  added          ${name}`);
    } else {
        console.log(`  already there  ${name}`);
    }
}

async function ensureMarketplaceColumns() {
    let categoryColumnAdded = false;
    const columns = [
        ['APP_USERS', 'IS_VERIFIED', 'NUMBER(1) DEFAULT 0 NOT NULL'],
        ['LISTINGS', 'CATEGORY', "VARCHAR2(60 CHAR) DEFAULT 'other-agricultural-products' NOT NULL"],
        ['LISTINGS', 'PRODUCT_DESCRIPTION', "VARCHAR2(2000 CHAR) DEFAULT 'Fresh agricultural products from a Zambian farm.' NOT NULL"],
        ['LISTINGS', 'UNIT', "VARCHAR2(20 CHAR) DEFAULT 'kg' NOT NULL"],
        ['LISTINGS', 'MINIMUM_ORDER_QUANTITY', 'NUMBER(12, 2) DEFAULT 1 NOT NULL'],
        ['LISTINGS', 'PROVINCE', "VARCHAR2(40 CHAR) DEFAULT 'Other' NOT NULL"],
        ['LISTINGS', 'IMAGE_URLS', "VARCHAR2(4000 CHAR) DEFAULT '[]' NOT NULL"],
        ['LISTINGS', 'HARVEST_DATE', 'DATE'],
        ['LISTINGS', 'DELIVERY_AVAILABLE', 'NUMBER(1) DEFAULT 0 NOT NULL'],
        ['ORDERS', 'PRODUCT_UNIT', "VARCHAR2(20 CHAR) DEFAULT 'kg' NOT NULL"],
        ['ORDERS', 'PAYMENT_METHOD', 'VARCHAR2(20 CHAR)'],
        ['ORDERS', 'MOBILE_MONEY_PROVIDER', 'VARCHAR2(20 CHAR)'],
        ['ORDERS', 'PAYMENT_STATUS', "VARCHAR2(20 CHAR) DEFAULT 'not_configured' NOT NULL"],
        ['ORDERS', 'PAYOUT_STATUS', "VARCHAR2(20 CHAR) DEFAULT 'not_configured' NOT NULL"],
        ['ORDERS', 'DELIVERY_STATUS', "VARCHAR2(20 CHAR) DEFAULT 'not_requested' NOT NULL"],
        ['ORDERS', 'DELIVERY_CONFIRMED_AT', 'TIMESTAMP WITH TIME ZONE'],
        ['TRANSPORT_REQUESTS', 'ORDER_ID', 'VARCHAR2(36)'],
    ];
    for (const [tableName, name, type] of columns) {
        const result = await db.execute(
            'SELECT COUNT(*) AS n FROM user_tab_columns WHERE table_name = :tableName AND column_name = :columnName',
            { tableName, columnName: name }
        );
        if (result.rows[0].N === 0) {
            await db.execute(`ALTER TABLE ${tableName.toLowerCase()} ADD (${name.toLowerCase()} ${type})`);
            console.log(`  added          ${tableName}.${name}`);
            if (tableName === 'LISTINGS' && name === 'CATEGORY') categoryColumnAdded = true;
        } else {
            console.log(`  already there  ${tableName}.${name}`);
        }
    }

    if (categoryColumnAdded) await db.execute(`UPDATE listings
                         SET category = CASE
                             WHEN LOWER(product) LIKE '%maize%' OR LOWER(product) LIKE '%corn%' THEN 'maize'
                             WHEN LOWER(product) LIKE '%tomato%' THEN 'tomatoes'
                             WHEN LOWER(product) LIKE '%groundnut%' OR LOWER(product) LIKE '%peanut%' THEN 'groundnuts'
                             WHEN LOWER(product) LIKE '%soya%' OR LOWER(product) LIKE '%soybean%' THEN 'soya-beans'
                             WHEN LOWER(product) LIKE '%rice%' THEN 'rice'
                             WHEN LOWER(product) LIKE '%fruit%' OR LOWER(product) LIKE '%mango%' OR LOWER(product) LIKE '%banana%' THEN 'fruits'
                             WHEN LOWER(product) LIKE '%vegetable%' OR LOWER(product) LIKE '%cabbage%' OR LOWER(product) LIKE '%onion%' OR LOWER(product) LIKE '%tomato%' THEN 'vegetables'
                             WHEN LOWER(product) LIKE '%fertilizer%' OR LOWER(product) LIKE '%fertiliser%' OR LOWER(product) LIKE '%seed%' OR LOWER(product) LIKE '%chemical%' THEN 'fertilizers-and-farming-supplies'
                             ELSE 'other-agricultural-products'
                         END
                       WHERE category = 'other-agricultural-products'`);

    await db.execute(`UPDATE listings
                         SET minimum_order_quantity = quantity_kg
                       WHERE quantity_kg > 0
                         AND minimum_order_quantity > quantity_kg`);

    const constraints = [
        ['APP_USERS_VERIFIED_CK', `ALTER TABLE app_users ADD CONSTRAINT app_users_verified_ck
            CHECK (is_verified IN (0, 1))`],
        ['LISTINGS_CATEGORY_CK', `ALTER TABLE listings ADD CONSTRAINT listings_category_ck
            CHECK (category IN ('maize', 'tomatoes', 'groundnuts', 'soya-beans', 'vegetables', 'rice', 'fruits',
                'fertilizers-and-farming-supplies', 'other-agricultural-products'))`],
        ['LISTINGS_UNIT_CK', `ALTER TABLE listings ADD CONSTRAINT listings_unit_ck
            CHECK (unit IN ('kg', 'bag', 'tonne', 'crate', 'each', 'litre'))`],
        ['LISTINGS_MIN_ORDER_CK', `ALTER TABLE listings ADD CONSTRAINT listings_min_order_ck
            CHECK (minimum_order_quantity > 0)`],
        ['LISTINGS_MIN_AVAILABLE_CK', `ALTER TABLE listings ADD CONSTRAINT listings_min_available_ck
            CHECK (quantity_kg = 0 OR minimum_order_quantity <= quantity_kg)`],
        ['LISTINGS_DELIVERY_CK', `ALTER TABLE listings ADD CONSTRAINT listings_delivery_ck
            CHECK (delivery_available IN (0, 1))`],
        ['ORDERS_PAYMENT_STATUS_CK', `ALTER TABLE orders ADD CONSTRAINT orders_payment_status_ck
            CHECK (payment_status IN ('not_configured', 'pending', 'paid', 'failed', 'refunded'))`],
        ['ORDERS_PAYOUT_STATUS_CK', `ALTER TABLE orders ADD CONSTRAINT orders_payout_status_ck
            CHECK (payout_status IN ('not_configured', 'pending', 'paid'))`],
        ['ORDERS_DELIVERY_STATUS_CK', `ALTER TABLE orders ADD CONSTRAINT orders_delivery_status_ck
            CHECK (delivery_status IN ('not_requested', 'requested', 'in_transit', 'delivered', 'confirmed'))`],
        ['TRANSPORT_ORDER_FK', `ALTER TABLE transport_requests ADD CONSTRAINT transport_order_fk
            FOREIGN KEY (order_id) REFERENCES orders (id)`],
    ];
    for (const [name, sql] of constraints) await ensureConstraint(name, sql);
}

async function ensureAdminRoleConstraint() {
    const result = await db.execute(
        `SELECT search_condition_vc AS role_check
           FROM user_constraints
          WHERE constraint_name = 'APP_USERS_ROLE_CK'`
    );
    const existing = result.rows[0];
    if (existing && existing.ROLE_CHECK.toLowerCase().includes("'admin'")) {
        console.log('  already there  APP_USERS_ROLE_CK (admin enabled)');
        return;
    }
    if (existing) {
        await db.execute('ALTER TABLE app_users DROP CONSTRAINT app_users_role_ck');
    }
    await db.execute(`ALTER TABLE app_users ADD CONSTRAINT app_users_role_ck
        CHECK (user_role IN ('farmer', 'buyer', 'transporter', 'admin'))`);
    console.log(`  ${existing ? 'updated' : 'added'}        APP_USERS_ROLE_CK (admin enabled)`);
}

(async () => {
    try {
        const who = await db.execute('SELECT USER AS u FROM dual');
        console.log(`Connected to Oracle as ${who.rows[0].U}.\n`);

        console.log('Tables:');
        for (const table of TABLES) {
            if (await exists('table', table.name)) {
                console.log(`  already there  ${table.name}`);
            } else {
                await db.execute(table.sql);
                console.log(`  created        ${table.name}`);
            }
        }

        console.log('\nMarketplace workflow columns:');
        await ensureMarketplaceColumns();
        await ensureAdminRoleConstraint();

        console.log('\nIndexes:');
        for (const [name, sql] of INDEXES) {
            if (await exists('index', name)) {
                console.log(`  already there  ${name}`);
            } else {
                await db.execute(sql);
                console.log(`  created        ${name}`);
            }
        }

        console.log('\nRows in each table right now:');
        for (const table of TABLES) {
            const count = await db.execute(`SELECT COUNT(*) AS n FROM ${table.name}`);
            console.log(`  ${table.name.padEnd(20)} ${count.rows[0].N}`);
        }
        console.log('\nDone. The database is ready.');
    } catch (error) {
        console.error('\nSetup stopped:', error.message);
        const hint = explain(error);
        if (hint) console.error('Hint:', hint);
        process.exitCode = 1;
    } finally {
        await db.stop();
    }
})();
