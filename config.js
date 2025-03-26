require('dotenv').config();

module.exports = {
    telegram: {
        token: process.env.TELEGRAM_BOT_TOKEN
    },
    concertApis: {
        chemiefabrik: 'https://www.chemiefabrik.info/gigs/',
        alterSchlachthof: 'https://www.alter-schlachthof.de/api/getEvents',
        jungeGarde: 'https://www.junge-garde.com/api/getEvents'
    },
    cache: {
        concertDataFile: './data/concerts.json',
        userDataFile: './data/users.json',
        updateInterval: 24 * 60 * 60 * 1000 // 24 hours
    }
}; 