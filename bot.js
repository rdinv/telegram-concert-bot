const TelegramBot = require('node-telegram-bot-api');
const schedule = require('node-schedule');
const config = require('./config');
const concertService = require('./services/concertService');
const userService = require('./services/userService');
const { initializeDatabase } = require('./db');

const bot = new TelegramBot(config.telegram.token, { polling: true });

// Initialize services
async function initialize() {
    await initializeDatabase(); // Инициализация базы данных
    await concertService.initialize();
    await userService.initialize();
    setupScheduledTasks();
}

// Setup scheduled tasks
function setupScheduledTasks() {
    // Check for new concerts daily at midnight
    schedule.scheduleJob('0 0 * * *', async () => {
        await concertService.updateConcerts();
        await checkNewConcerts();
    });

    // Check for upcoming concerts daily at 20:00
    schedule.scheduleJob('0 20 * * *', async () => {
        await checkUpcomingConcerts();
    });
}

// Check for new concerts and notify users
async function checkNewConcerts() {
    console.log('Checking for new concerts...');
    const concerts = concertService.getUpcomingConcerts();
    
    // Get all users
    const users = userService.getAllUsers();
    
    for (const concert of concerts) {
        // Get users subscribed to this venue
        const venueSubscribers = userService.getUsersBySubscribedVenue(concert.venue);
        
        for (const user of venueSubscribers) {
            // Check if user was already notified about this concert
            if (!userService.wasUserNotifiedAboutConcert(user.userId, concert.id)) {
                await bot.sendMessage(user.userId, `🎵 New concert at ${concert.venue}!`);
                await sendConcertNotification(user.userId, concert);
                await userService.markConcertAsNotified(user.userId, concert.id);
            }
        }
    }
}

// Check for upcoming concerts and send reminders
async function checkUpcomingConcerts() {
    console.log('Checking for upcoming concerts...');
    const concerts = concertService.getUpcomingConcerts();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    const dayAfterTomorrow = new Date(tomorrow);
    dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 1);

    for (const concert of concerts) {
        const concertDate = new Date(concert.date);
        concertDate.setHours(0, 0, 0, 0);

        if (concertDate.getTime() === tomorrow.getTime()) {
            const subscribedUsers = userService.getSubscribedUsers(concert.id);
            for (const user of subscribedUsers) {
                await bot.sendMessage(user.userId, '🔔 Reminder! You have a concert tomorrow:');
                await sendConcertNotification(user.userId, concert);
            }
        }
    }
}

// Format concert message
function formatConcertMessage(concert) {
    const artistsList = concert.artists
        .map(artist => `• <a href="${artist.link}">${artist.name}</a>`)
        .join('\n');

    return `
🎵 <b>${concert.title}</b>
📅 ${new Date(concert.date).toLocaleString('ru-RU')}
📍 ${concert.venue}
💰 ${concert.price}

<b>Artists:</b>
${artistsList}
    `.trim();
}

// Send concert notification
async function sendConcertNotification(userId, concert) {
    const message = formatConcertMessage(concert);
    const isSubscribed = userService.isSubscribed(userId, concert.id);

    const keyboard = {
        inline_keyboard: [
            [
                isSubscribed
                    ? { text: '❌ Remove from favorites', callback_data: `u_${concert.id}` }
                    : { text: '⭐ Add to favorites', callback_data: `f_${concert.id}` }
            ]
        ]
    };

    if (concert.poster) {
        await bot.sendPhoto(userId, concert.poster, {
            caption: message,
            parse_mode: 'HTML',
            reply_markup: keyboard
        });
    } else {
        await bot.sendMessage(userId, message, {
            parse_mode: 'HTML',
            reply_markup: keyboard
        });
    }
}

// Send concert reminder
async function sendConcertReminder(userId, concert) {
    const message = `🔔 Reminder! There is a concert tomorrow:\n\n${formatConcertMessage(concert)}`;
    await bot.sendMessage(userId, message, { parse_mode: 'HTML' });
}

// Command handlers
bot.onText(/\/start/, async (msg) => {
    const userId = msg.from.id;
    await userService.addUser(userId, {
        username: msg.from.username,
        firstName: msg.from.first_name,
        lastName: msg.from.last_name
    });

    const keyboard = {
        reply_markup: {
            keyboard: [
                ['🎵 View all concerts'],
                ['📍 Concerts by location'],
                ['⭐ Favorites']
            ],
            resize_keyboard: true
        }
    };

    await bot.sendMessage(userId, 'Hello! I am a concert tracking bot. How can I help you?', keyboard);
});

bot.onText(/🎵 View all concerts/, async (msg) => {
    const userId = msg.from.id;
    
    try {
        // Send loading message
        await bot.sendMessage(userId, 'Loading concerts list...');
        
        // Update concert data
        await concertService.updateConcerts();
        
        // Get concerts list
        const concerts = concertService.getUpcomingConcerts();
        
        if (concerts.length === 0) {
            await bot.sendMessage(userId, 'No concerts available at the moment.');
            return;
        }

        // Send each concert
        for (const concert of concerts) {
            await sendConcertNotification(userId, concert);
        }
    } catch (error) {
        console.error('Error showing concerts:', error);
        await bot.sendMessage(userId, 'There was an error loading concerts. Please try again later.');
    }
});

bot.onText(/📍 Concerts by location/, async (msg) => {
    const userId = msg.from.id;

    try {
        const venues = await concertService.getVenues(); // Убедимся, что getVenues возвращает данные
        const subscribedVenues = await userService.getSubscribedVenues(userId); // Получаем подписанные локации из базы данных

        if (venues.length === 0) {
            await bot.sendMessage(userId, 'No venues available at the moment.');
            return;
        }

        const keyboard = {
            inline_keyboard: venues.map(venue => {
                const isSubscribed = subscribedVenues.includes(venue);
                return [{
                    text: `${venue} ${isSubscribed ? '✅' : ''}`,
                    callback_data: `venue_${venue}`
                }];
            })
        };

        await bot.sendMessage(userId, 'Select a venue (✅ - subscribed to notifications):', { reply_markup: keyboard });
    } catch (error) {
        console.error('Error fetching venues:', error);
        await bot.sendMessage(userId, 'There was an error loading venues. Please try again later.');
    }
});

// Add handler for favorites button
bot.onText(/⭐ Favorites/, async (msg) => {
    const userId = msg.from.id;
    const user = await userService.getUser(userId); // Используем await для получения данных из базы

    if (!user || !user.subscribedConcerts || JSON.parse(user.subscribedConcerts).length === 0) {
        await bot.sendMessage(userId, 'You have no favorite concerts yet.');
        return;
    }

    console.log('User subscribed concerts:', user.subscribedConcerts);

    const favoriteConcerts = JSON.parse(user.subscribedConcerts)
        .map(concertId => {
            const concert = concertService.getConcertById(concertId);
            if (!concert) {
                console.log(`Concert with ID ${concertId} not found`);
                // Remove non-existent concert from user subscriptions
                userService.unsubscribeFromConcert(userId, concertId);
                return null;
            }
            return concert;
        })
        .filter(concert => concert !== null)
        .filter(concert => {
            const concertDate = new Date(concert.date);
            const now = new Date();
            const isUpcoming = concertDate > now;
            console.log(`Concert ${concert.id}: date=${concert.date}, isUpcoming=${isUpcoming}`);
            return isUpcoming;
        })
        .sort((a, b) => {
            const dateA = new Date(a.date);
            const dateB = new Date(b.date);
            console.log(`Comparing dates: ${a.title} (${dateA.toISOString()}) vs ${b.title} (${dateB.toISOString()})`);
            return dateA - dateB;
        }); // Sort by date, nearest first

    console.log('Found favorite concerts:', favoriteConcerts);

    if (favoriteConcerts.length === 0) {
        await bot.sendMessage(userId, 'You have no upcoming favorite concerts.');
        return;
    }

    await bot.sendMessage(userId, 'Your favorite concerts:');
    
    // Send concerts one by one, starting with the nearest
    for (let i = 0; i < favoriteConcerts.length; i++) {
        const concert = favoriteConcerts[i];
        console.log(`Sending concert ${i + 1}/${favoriteConcerts.length}: ${concert.title} (${concert.date})`);
        await sendConcertNotification(userId, concert);
        
        // Add small delay between messages
        if (i < favoriteConcerts.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
});

// Callback query handlers
bot.on('callback_query', async (callbackQuery) => {
    const userId = callbackQuery.from.id;
    const data = callbackQuery.data;

    if (data.startsWith('venue_')) {
        const venue = data.replace('venue_', '');
        const isSubscribed = userService.isSubscribedToVenue(userId, venue);
        
        // Create keyboard for venue subscription
        const subscriptionKeyboard = {
            inline_keyboard: [
                [
                    {
                        text: isSubscribed ? '❌ Unsubscribe from venue' : '🔔 Subscribe to venue',
                        callback_data: isSubscribed ? `unsub_venue_${venue}` : `sub_venue_${venue}`
                    }
                ],
                [
                    {
                        text: '📋 Show concerts',
                        callback_data: `show_venue_${venue}`
                    }
                ]
            ]
        };

        await bot.editMessageText(
            `Venue: ${venue}\n${isSubscribed ? '✅ You are subscribed to notifications' : ''}`,
            {
                chat_id: callbackQuery.message.chat.id,
                message_id: callbackQuery.message.message_id,
                reply_markup: subscriptionKeyboard
            }
        );
    } else if (data.startsWith('sub_venue_')) {
        const venue = data.replace('sub_venue_', '');
        await userService.subscribeToVenue(userId, venue);
        await bot.answerCallbackQuery(callbackQuery.id, {
            text: `Subscribed to notifications for ${venue}!`
        });
        
        // Update message with new subscription status
        const subscriptionKeyboard = {
            inline_keyboard: [
                [
                    {
                        text: '❌ Unsubscribe from venue',
                        callback_data: `unsub_venue_${venue}`
                    }
                ],
                [
                    {
                        text: '📋 Show concerts',
                        callback_data: `show_venue_${venue}`
                    }
                ]
            ]
        };

        await bot.editMessageText(
            `Venue: ${venue}\n✅ You are subscribed to notifications`,
            {
                chat_id: callbackQuery.message.chat.id,
                message_id: callbackQuery.message.message_id,
                reply_markup: subscriptionKeyboard
            }
        );
    } else if (data.startsWith('unsub_venue_')) {
        const venue = data.replace('unsub_venue_', '');
        await userService.unsubscribeFromVenue(userId, venue);
        await bot.answerCallbackQuery(callbackQuery.id, {
            text: `Unsubscribed from notifications for ${venue}`
        });
        
        // Update message with new subscription status
        const subscriptionKeyboard = {
            inline_keyboard: [
                [
                    {
                        text: '🔔 Subscribe to venue',
                        callback_data: `sub_venue_${venue}`
                    }
                ],
                [
                    {
                        text: '📋 Show concerts',
                        callback_data: `show_venue_${venue}`
                    }
                ]
            ]
        };

        await bot.editMessageText(
            `Venue: ${venue}`,
            {
                chat_id: callbackQuery.message.chat.id,
                message_id: callbackQuery.message.message_id,
                reply_markup: subscriptionKeyboard
            }
        );
    } else if (data.startsWith('show_venue_')) {
        const venue = data.replace('show_venue_', '');
        const concerts = concertService.getConcertsByVenue(venue);

        // Send concerts one by one, starting with the nearest
        for (let i = 0; i < concerts.length; i++) {
            const concert = concerts[i];
            console.log(`Sending venue concert ${i + 1}/${concerts.length}: ${concert.title} (${concert.date})`);
            await sendConcertNotification(userId, concert);
            
            // Add small delay between messages
            if (i < concerts.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
    } else if (data.startsWith('f_')) {
        const concertId = data.replace('f_', '');
        const isSubscribed = await userService.subscribeToConcert(userId, concertId);
        
        if (isSubscribed) {
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: 'Concert added to favorites!'
            });
            // Update message with new buttons
            const concert = concertService.getConcertById(concertId);
            if (concert) {
                await updateConcertMessage(callbackQuery.message, userId, concert);
            }
        }
    } else if (data.startsWith('u_')) {
        const concertId = data.replace('u_', '');
        const isUnsubscribed = await userService.unsubscribeFromConcert(userId, concertId);
        
        if (isUnsubscribed) {
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: 'Concert removed from favorites!'
            });
            // Update message with new buttons
            const concert = concertService.getConcertById(concertId);
            if (concert) {
                await updateConcertMessage(callbackQuery.message, userId, concert);
            }
        }
    }
});

// Function to update concert message
async function updateConcertMessage(message, userId, concert) {
    const newMessage = formatConcertMessage(concert);
    const isSubscribed = userService.isSubscribed(userId, concert.id);

    const keyboard = {
        inline_keyboard: [
            [
                isSubscribed
                    ? { text: '❌ Remove from favorites', callback_data: `u_${concert.id}` }
                    : { text: '⭐ Add to favorites', callback_data: `f_${concert.id}` }
            ]
        ]
    };

    if (message.photo) {
        await bot.editMessageCaption(newMessage, {
            chat_id: message.chat.id,
            message_id: message.message_id,
            parse_mode: 'HTML',
            reply_markup: keyboard
        });
    } else {
        await bot.editMessageText(newMessage, {
            chat_id: message.chat.id,
            message_id: message.message_id,
            parse_mode: 'HTML',
            reply_markup: keyboard
        });
    }
}

// Initialize bot
initialize().catch(console.error);