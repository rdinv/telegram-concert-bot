const fs = require('fs').promises;
const path = require('path');
const config = require('../config');
const concertService = require('./concertService');
const { pool } = require('../db');

class UserService {
    constructor() {
        this.users = new Map();
    }

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
        const user = this.users.get(userId);
        if (user) {
            user.subscribedConcerts = user.subscribedConcerts.filter(id => id !== concertId);
            await this.saveUsersToCache();
            return true;
        }
        return false;
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

    isSubscribedToVenue(userId, venue) {
        const user = this.users.get(userId);
        return user && user.subscribedVenues.includes(venue);
    }

    getSubscribedVenues(userId) {
        const user = this.users.get(userId);
        return user ? user.subscribedVenues : [];
    }

    getUsersBySubscribedVenue(venue) {
        return Array.from(this.users.values())
            .filter(user => user.subscribedVenues.includes(venue));
    }

    isSubscribed(userId, concertId) {
        const user = this.users.get(userId);
        return user && user.subscribedConcerts.includes(concertId);
    }

    getSubscribedUsers(concertId) {
        return Array.from(this.users.values())
            .filter(user => user.subscribedConcerts.includes(concertId));
    }

    async markConcertAsNotified(userId, concertId) {
        const user = this.users.get(userId);
        if (user) {
            if (!user.lastNotifiedConcerts) {
                user.lastNotifiedConcerts = new Set();
            }
            user.lastNotifiedConcerts.add(concertId);
            await this.saveUsersToCache();
            return true;
        }
        return false;
    }

    wasUserNotifiedAboutConcert(userId, concertId) {
        const user = this.users.get(userId);
        return user && user.lastNotifiedConcerts && user.lastNotifiedConcerts.has(concertId);
    }
}

module.exports = new UserService();