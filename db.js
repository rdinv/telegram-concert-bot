const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.MYSQLHOST,
    user: process.env.MYSQLUSER,
    password: process.env.MYSQLPASSWORD,
    database: process.env.MYSQLDATABASE,
    port: process.env.MYSQLPORT,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

async function initializeDatabase() {
    const connection = await pool.getConnection();
    try {
        // Create users table
        await connection.query(`
            CREATE TABLE IF NOT EXISTS users (
                userId VARCHAR(255) PRIMARY KEY,
                username VARCHAR(255),
                firstName VARCHAR(255),
                lastName VARCHAR(255),
                subscribedConcerts TEXT,
                subscribedVenues TEXT,
                lastNotifiedConcerts TEXT,
                createdAt DATETIME
            )
        `);

        // Create concerts table
        await connection.query(`
            CREATE TABLE IF NOT EXISTS concerts (
                id VARCHAR(255) PRIMARY KEY,
                title VARCHAR(255),
                date DATETIME,
                venue VARCHAR(255),
                price VARCHAR(255),
                poster TEXT,
                subscribers TEXT
            )
        `);
    } finally {
        connection.release();
    }
}

module.exports = { pool, initializeDatabase };
