'use strict';

/*
 * Connection to the Oracle database. Everything that talks to Oracle goes through here.
 * The login details come from the .env file (never from this code):
 *   DB_USER, DB_PASSWORD, DB_CONNECTION_STRING, DB_WALLET_PASSWORD
 * and the wallet files live in the "wallet" folder next to this file.
 */

const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const oracledb = require('oracledb');

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT; // each row comes back as an object, e.g. row.NAME

const walletDir = path.join(__dirname, 'wallet');
let pool = null;

function settings() {
    const needed = ['DB_USER', 'DB_PASSWORD', 'DB_CONNECTION_STRING', 'DB_WALLET_PASSWORD'];
    const missing = needed.filter((name) => !process.env[name]);
    if (missing.length > 0) {
        throw new Error(`Missing in your .env file: ${missing.join(', ')}`);
    }
    return {
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        connectString: process.env.DB_CONNECTION_STRING,
        configDir: walletDir,
        walletLocation: walletDir,
        walletPassword: process.env.DB_WALLET_PASSWORD,
    };
}

async function start() {
    if (pool) return;
    pool = await oracledb.createPool({
        ...settings(),
        poolMin: 0, // free databases have few connections, so only open what is needed
        poolMax: 4,
        poolIncrement: 1,
        poolTimeout: 60,
    });
}

// Run one statement. Changes are saved straight away unless you pass { autoCommit: false }.
async function execute(sql, binds = {}, options = {}) {
    if (!pool) await start();
    const connection = await pool.getConnection();
    try {
        return await connection.execute(sql, binds, { autoCommit: true, ...options });
    } finally {
        await connection.close(); // gives the connection back to the pool
    }
}

// Run several statements as one unit: either they all save, or none do.
async function withTransaction(work) {
    if (!pool) await start();
    const connection = await pool.getConnection();
    try {
        const result = await work((sql, binds = {}, options = {}) =>
            connection.execute(sql, binds, { autoCommit: false, ...options }));
        await connection.commit();
        return result;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        await connection.close();
    }
}

async function stop() {
    if (pool) {
        await pool.close(10);
        pool = null;
    }
}

module.exports = { start, execute, withTransaction, stop, oracledb };
