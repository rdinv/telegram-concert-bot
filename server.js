require('./bot');
const cheerio = require('cheerio');
require('dotenv').config(); // Load environment variables

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const URL = 'https://www.chemiefabrik.info/gigs/';

const bot = new TelegramBot(TOKEN, { polling: true });

let favoriteConcerts = [];

async function fetchConcerts() {
    try {
        const { data } = await axios.get(URL);
        const $ = cheerio.load(data);
        
        let concerts = [];
        
        $('.elementor-element-cdc7517').each((i, el) => {
            const title = $(el).find('.bandlink').text().trim();
            const date = $(el).find('.elementor-element-93c9594').text().trim();
            const image = $(el).find('img').attr('src');
            const links = [];
            const preis = $(el).find('.elementor-element-307babc').text().trim();
            const genreLocation = $(el).find('.bandlink').parent().text().trim();

            $(el).find('.bandlink').each((j, link) => {
                links.push({ text: $(link).text().trim(), url: $(link).attr('href') });
            });

            concerts.push({ title, date, image, links, preis, genreLocation });
        });
        return concerts;
    } catch (error) {
        console.error('Error while getting concerts:', error);
        return [];
    }
}

async function sendConcerts(chatId) {
    const concerts = await fetchConcerts();
    
    // Limit to the next 15 concerts
    const limitedConcerts = concerts.slice(0, 15);
    
    for (const concert of limitedConcerts) {
        let message = `&#10678; <b>${concert.title}</b> &#10678; \n${concert.genreLocation}\n\n📅 ${concert.date}\n\n ${concert.preis}\n\n`;

        concert.links.forEach(link => {
            message += `<a href='${link.url}'>${link.text}</a>\n`;
        });

        const isFavorite = favoriteConcerts.includes(concert.title);
        const buttonText = isFavorite ? 'Remove from favorites' : 'Add to favorites';
        const callbackData = isFavorite ? `unfavorite_${concert.title}` : `favorite_${concert.title}`;
        
        await bot.sendPhoto(chatId, concert.image, {
            caption: message,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[
                    { text: buttonText, callback_data: callbackData }
                ]]
            }
        });
    }
}

cron.schedule('0 * * * *', () => {
    console.log('Checking out new concerts...');
    sendConcerts(CHAT_ID);
});

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "Hello! I'm a bot sending information about concerts in Chemiefabrik.", {
        reply_markup: {
            keyboard: [[{ text: '🎵 List of concerts' }, { text: '⭐ Favorites' }]],
            resize_keyboard: true
        }
    });
});

bot.on('message', async (msg) => {
    if (msg.text === '🎵 List of concerts') {
        await sendConcerts(msg.chat.id);
    } else if (msg.text === '⭐ Favorites') {
        if (favoriteConcerts.length === 0) {
            bot.sendMessage(msg.chat.id, 'Your favorites list is empty.');
        } else {
            for (const concertTitle of favoriteConcerts) {
                const concerts = await fetchConcerts();
                const concert = concerts.find(c => c.title === concertTitle);
                if (concert) {
                    let message = `&#10678; <b>${concert.title}</b> &#10678; \n${concert.genreLocation}\n\n📅 ${concert.date}\n\n ${concert.preis}\n\n`;
                    concert.links.forEach(link => {
                        message += `<a href='${link.url}'>${link.text}</a>\n`;
                    });

                    const buttonText = 'Remove from favorites';
                    const callbackData = `unfavorite_${concert.title}`;
                    
                    await bot.sendPhoto(msg.chat.id, concert.image, {
                        caption: message,
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: buttonText, callback_data: callbackData }
                            ]]
                        }
                    });
                }
            }
        }
    }
});

bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    if (query.data.startsWith('favorite_')) {
        const concertTitle = query.data.replace('favorite_', '');
        if (!favoriteConcerts.includes(concertTitle)) {
            favoriteConcerts.push(concertTitle);
            bot.sendMessage(chatId, `✅ Concert "${concertTitle}" added to favorites.`);
        } else {
            bot.sendMessage(chatId, `⚠️ The concert is already in your favorites.`);
        }
    } else if (query.data.startsWith('unfavorite_')) {
        const concertTitle = query.data.replace('unfavorite_', '');
        const index = favoriteConcerts.indexOf(concertTitle);
        if (index > -1) {
            favoriteConcerts.splice(index, 1);
            bot.sendMessage(chatId, `❌ Concert "${concertTitle}" removed from favorites.`);
        } else {
            bot.sendMessage(chatId, `⚠️ Concert not found in favorites.`);
        }
    }
});

cron.schedule('0 12 * * *', async () => {
    const concerts = await fetchConcerts();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const formattedTomorrow = tomorrow.toISOString().split('T')[0];
    
    concerts.forEach(concert => {
        if (concert.date.includes(formattedTomorrow)) {
            bot.sendMessage(CHAT_ID, `⏳ Reminder! Concert tomorrow: ${concert.title}`);
        }
    });
});