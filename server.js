const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');

const TOKEN = '8037692637:AAF8hQ8iHx0lU89bb_4R7POUkPyu08zO3lk';
const CHAT_ID = 'YOUR_CHAT_ID';
const URL = 'https://www.chemiefabrik.info/gigs/';

const bot = new TelegramBot(TOKEN, { polling: true });

let favoriteConcerts = [];

async function fetchConcerts() {
    try {
        const { data } = await axios.get(URL);
        const $ = cheerio.load(data);
        
        let concerts = [];
        
        $('.elementor-81').each((i, el) => {
            const title = $(el).find('title').text().trim();
            const date = $(el).find('.elementor-element-93c9594').text().trim();
            const image = $(el).find('img').attr('src');
            const links = [];
            const genre = $(el).find('.jet-listing-dynamic-repeater__item').text().trim().replace(/.*?(?:\s{2,}|\n)/, ''); // Получаем жанр

            $(el).find('.bandlink').each((j, link) => {
                const url = $(link).attr('href');
                const text = $(link).text().trim();
                if (url && text) {
                    links.push({ text, url });
                }
            });

            concerts.push({ title: `${title} / ${genre}`, date, image, links });
        });
        return concerts;
    } catch (error) {
        console.error('Ошибка при получении концертов:', error);
        return [];
    }
}

async function sendConcerts(chatId) {
    const concerts = await fetchConcerts();
    
    for (const concert of concerts) {
        let message = `<b>${concert.title}</b>\n📅 ${concert.date}\n\n`;
        concert.links.forEach(link => {
            message += `<a href='${link.url}'>${link.text}</a>\n`;
        });
        
        await bot.sendPhoto(chatId, concert.image, {
            caption: message,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[
                    { text: 'Добавить в избранное', callback_data: `favorite_${concert.title}` }
                ]]
            }
        });
    }
}

cron.schedule('0 * * * *', () => {
    console.log('Проверка новых концертов...');
    sendConcerts(CHAT_ID);
});

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Привет! Я бот, присылающий информацию о концертах в Chemiefabrik.', {
        reply_markup: {
            keyboard: [[{ text: '🎵 Список концертов' }, { text: '⭐ Избранное' }]],
            resize_keyboard: true
        }
    });
});

bot.on('message', (msg) => {
    if (msg.text === '🎵 Список концертов') {
        sendConcerts(msg.chat.id);
    } else if (msg.text === '⭐ Избранное') {
        if (favoriteConcerts.length === 0) {
            bot.sendMessage(msg.chat.id, 'Ваш список избранного пуст.');
        } else {
            favoriteConcerts.forEach(concert => {
                bot.sendMessage(msg.chat.id, `⭐ <b>${concert}</b>`, { parse_mode: 'HTML' });
            });
        }
    }
});

bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    if (query.data.startsWith('favorite_')) {
        const concertTitle = query.data.replace('favorite_', '');
        if (!favoriteConcerts.includes(concertTitle)) {
            favoriteConcerts.push(concertTitle);
            bot.sendMessage(chatId, `✅ Концерт "${concertTitle}" добавлен в избранное.`);
        } else {
            bot.sendMessage(chatId, `⚠️ Концерт уже в избранном.`);
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
            bot.sendMessage(CHAT_ID, `⏳ Напоминание! Завтра концерт: ${concert.title}`);
        }
    });
});
