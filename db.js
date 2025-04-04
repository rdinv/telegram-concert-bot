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
        console.log('Initializing database...');
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
        console.log('Users table ensured.');

        await connection.query(`
            CREATE TABLE IF NOT EXISTS concerts (
                id VARCHAR(255) PRIMARY KEY,
                title VARCHAR(255),
                date DATETIME,
                venue VARCHAR(255),
                price VARCHAR(255),
                poster TEXT,
                subscribers TEXT,
                artists TEXT
            )
        `);
        console.log('Concerts table ensured.');

        // Проверяем и добавляем поле artists, если оно отсутствует
        const [columns] = await connection.query(`SHOW COLUMNS FROM concerts LIKE 'artists'`);
        if (columns.length === 0) {
            await connection.query(`ALTER TABLE concerts ADD artists TEXT`);
            console.log('Added missing column "artists" to concerts table.');
        }
    } catch (error) {
        console.error('Error initializing database:', error);
        throw error;
    } finally {
        connection.release();
    }
}

module.exports = { pool, initializeDatabase };