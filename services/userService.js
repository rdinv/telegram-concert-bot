const fs = require('fs').promises;
const path = require('path');
const config = require('../config');
const { pool } = require('../db');

class UserService {
    async initialize() {
        try {
            const data = await fs.readFile(config.cache.userDataFile, 'utf8');
            const users = JSON.parse(data);
            this.users = new Map(users.map(user => [user.userId, user]));
        } catch (error) {
            console.log('No cached user data found');
        }
    }

    async saveUsersToCache() {
        try {
            await fs.mkdir(path.dirname(config.cache.userDataFile), { recursive: true });
            await fs.writeFile(
                config.cache.userDataFile,
                JSON.stringify(Array.from(this.users.values()), null, 2)
            );
        } catch (error) {
            console.error('Error saving users to cache:', error);
        }
    }

    async addUser(userId, userInfo) {
        const connection = await pool.getConnection();
        try {
            const [rows] = await connection.query(
                'SELECT * FROM users WHERE userId = ?',
                [userId]
            );

            if (rows.length === 0) {
                const createdAt = new Date().toISOString().slice(0, 19).replace('T', ' '); // Format to 'YYYY-MM-DD HH:MM:SS'
                await connection.query(
                    `INSERT INTO users (userId, username, firstName, lastName, subscribedConcerts, subscribedVenues, lastNotifiedConcerts, createdAt)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        userId,
                        userInfo.username || null,
                        userInfo.firstName || null,
                        userInfo.lastName || null,
                        JSON.stringify([]),
                        JSON.stringify([]),
                        JSON.stringify([]),
                        createdAt
                    ]
                );
            }
        } finally {
            connection.release();
        }
    }

    async getUser(userId) {
        const connection = await pool.getConnection();
        try {
            const [rows] = await connection.query(
                'SELECT * FROM users WHERE userId = ?',
                [userId]
            );
            return rows.length > 0 ? rows[0] : null;
        } finally {
            connection.release();
        }
    }

    async getAllUsers() {
        const connection = await pool.getConnection();
        try {
            const [rows] = await connection.query('SELECT * FROM users');
            return rows;
        } finally {
            connection.release();
        }
    }

    async subscribeToConcert(userId, concertId) {
        const connection = await pool.getConnection();
        try {
            const [rows] = await connection.query(
                'SELECT subscribedConcerts FROM users WHERE userId = ?',
                [userId]
            );

            if (rows.length > 0) {
                const subscribedConcerts = JSON.parse(rows[0].subscribedConcerts || '[]');
                if (!subscribedConcerts.includes(concertId)) {
                    subscribedConcerts.push(concertId);
                    await connection.query(
                        'UPDATE users SET subscribedConcerts = ? WHERE userId = ?',
                        [JSON.stringify(subscribedConcerts), userId]
                    );
                    return true;
                }
            }
            return false;
        } finally {
            connection.release();
        }
    }

    async unsubscribeFromConcert(userId, concertId) {
        const connection = await pool.getConnection();
        try {
            const [rows] = await connection.query(
                'SELECT subscribedConcerts FROM users WHERE userId = ?',
                [userId]
            );

            if (rows.length > 0) {
                const subscribedConcerts = JSON.parse(rows[0].subscribedConcerts || '[]');
                const updatedConcerts = subscribedConcerts.filter(id => id !== concertId);
                await connection.query(
                    'UPDATE users SET subscribedConcerts = ? WHERE userId = ?',
                    [JSON.stringify(updatedConcerts), userId]
                );
                return true;
            }
            return false;
        } finally {
            connection.release();
        }
    }

    async subscribeToVenue(userId, venue) {
        const connection = await pool.getConnection();
        try {
            const [rows] = await connection.query(
                'SELECT subscribedVenues FROM users WHERE userId = ?',
                [userId]
            );

            if (rows.length > 0) {
                const subscribedVenues = JSON.parse(rows[0].subscribedVenues || '[]');
                if (!subscribedVenues.includes(venue)) {
                    subscribedVenues.push(venue);
                    await connection.query(
                        'UPDATE users SET subscribedVenues = ? WHERE userId = ?',
                        [JSON.stringify(subscribedVenues), userId]
                    );
                    return true;
                }
            }
            return false;
        } finally {
            connection.release();
        }
    }

    async unsubscribeFromVenue(userId, venue) {
        const connection = await pool.getConnection();
        try {
            const [rows] = await connection.query(
                'SELECT subscribedVenues FROM users WHERE userId = ?',
                [userId]
            );

            if (rows.length > 0) {
                const subscribedVenues = JSON.parse(rows[0].subscribedVenues || '[]');
                const updatedVenues = subscribedVenues.filter(v => v !== venue);
                await connection.query(
                    'UPDATE users SET subscribedVenues = ? WHERE userId = ?',
                    [JSON.stringify(updatedVenues), userId]
                );
                return true;
            }
            return false;
        } finally {
            connection.release();
        }
    }

    async isSubscribedToVenue(userId, venue) {
        const connection = await pool.getConnection();
        try {
            const [rows] = await connection.query(
                'SELECT subscribedVenues FROM users WHERE userId = ?',
                [userId]
            );
            if (rows.length > 0) {
                const subscribedVenues = JSON.parse(rows[0].subscribedVenues || '[]');
                return subscribedVenues.includes(venue);
            }
            return false;
        } finally {
            connection.release();
        }
    }

    async getSubscribedVenues(userId) {
        const connection = await pool.getConnection();
        try {
            console.log(`Fetching subscribed venues for user ${userId}...`);
            const [rows] = await connection.query(
                'SELECT subscribedVenues FROM users WHERE userId = ?',
                [userId]
            );
            if (rows.length > 0) {
                const venues = JSON.parse(rows[0].subscribedVenues || '[]');
                console.log(`Subscribed venues for user ${userId}:`, venues);
                return venues;
            }
            return [];
        } catch (error) {
            console.error(`Error fetching subscribed venues for user ${userId}:`, error);
            return [];
        } finally {
            connection.release();
        }
    }

    async getUsersBySubscribedVenue(venue) {
        const connection = await pool.getConnection();
        try {
            const [rows] = await connection.query('SELECT * FROM users');
            return rows.filter(user => {
                const subscribedVenues = JSON.parse(user.subscribedVenues || '[]');
                return subscribedVenues.includes(venue);
            });
        } finally {
            connection.release();
        }
    }

    async isSubscribed(userId, concertId) {
        const connection = await pool.getConnection();
        try {
            const [rows] = await connection.query(
                'SELECT subscribedConcerts FROM users WHERE userId = ?',
                [userId]
            );
            if (rows.length > 0) {
                const subscribedConcerts = JSON.parse(rows[0].subscribedConcerts || '[]');
                return subscribedConcerts.includes(concertId);
            }
            return false;
        } finally {
            connection.release();
        }
    }

    async getSubscribedUsers(concertId) {
        const connection = await pool.getConnection();
        try {
            const [rows] = await connection.query('SELECT * FROM users');
            return rows.filter(user => {
                const subscribedConcerts = JSON.parse(user.subscribedConcerts || '[]');
                return subscribedConcerts.includes(concertId);
            });
        } finally {
            connection.release();
        }
    }

    async markConcertAsNotified(userId, concertId) {
        const connection = await pool.getConnection();
        try {
            const [rows] = await connection.query(
                'SELECT lastNotifiedConcerts FROM users WHERE userId = ?',
                [userId]
            );

            if (rows.length > 0) {
                const lastNotifiedConcerts = new Set(
                    JSON.parse(rows[0].lastNotifiedConcerts || '[]')
                );
                lastNotifiedConcerts.add(concertId);
                await connection.query(
                    'UPDATE users SET lastNotifiedConcerts = ? WHERE userId = ?',
                    [JSON.stringify(Array.from(lastNotifiedConcerts)), userId]
                );
                return true;
            }
            return false;
        } finally {
            connection.release();
        }
    }

    async wasUserNotifiedAboutConcert(userId, concertId) {
        const connection = await pool.getConnection();
        try {
            const [rows] = await connection.query(
                'SELECT lastNotifiedConcerts FROM users WHERE userId = ?',
                [userId]
            );
            if (rows.length > 0) {
                const lastNotifiedConcerts = JSON.parse(rows[0].lastNotifiedConcerts || '[]');
                return lastNotifiedConcerts.includes(concertId);
            }
            return false;
        } finally {
            connection.release();
        }
    }
}

module.exports = new UserService();