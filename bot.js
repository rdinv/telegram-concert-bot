const TelegramBot = require('node-telegram-bot-api');
const schedule = require('node-schedule');
const config = require('./config');
const concertService = require('./services/concertService');
const userService = require('./services/userService');
const { initializeDatabase } = require('./db');

const bot = new TelegramBot(config.telegram.token, { polling: true });

async function initialize() {
    try {
        console.log('Starting initialization...');
        await initializeDatabase();
        console.log('Database initialized.');
        await concertService.initialize();
        console.log('Concert service initialized.');
        await userService.initialize();
        console.log('User service initialized.');
        setupScheduledTasks();
        console.log('Scheduled tasks set up.');
    } catch (error) {
        console.error('Error during initialization:', error);
        process.exit(1);
    }
}

function setupScheduledTasks() {
    schedule.scheduleJob('0 0 * * *', async () => {
        try {
            await concertService.updateConcerts();
            await checkNewConcerts();
        } catch (error) {
            console.error('Error in scheduled task (new concerts):', error);
        }
    });

    schedule.scheduleJob('0 20 * * *', async () => {
        try {
            await checkUpcomingConcerts();
        } catch (error) {
            console.error('Error in scheduled task (upcoming concerts):', error);
        }
    });
}

async function checkNewConcerts() {
    try {
        console.log('Checking for new concerts...');
        const concerts = await concertService.getUpcomingConcerts();
        const users = await userService.getAllUsers();

        for (const concert of concerts) {
            const venueSubscribers = await userService.getUsersBySubscribedVenue(concert.venue);
            for (const user of venueSubscribers) {
                if (!await userService.wasUserNotifiedAboutConcert(user.userId, concert.id)) {
                    await bot.sendMessage(user.userId, `🎵 New concert at ${concert.venue}!`);
                    await sendConcertNotification(user.userId, concert);
                    await userService.markConcertAsNotified(user.userId, concert.id);
                }
            }
        }
    } catch (error) {
        console.error('Error checking new concerts:', error);
    }
}

async function checkUpcomingConcerts() {
    try {
        console.log('Checking for upcoming concerts...');
        const concerts = await concertService.getUpcomingConcerts();
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);

        for (const concert of concerts) {
            const concertDate = new Date(concert.date);
            concertDate.setHours(0, 0, 0, 0);

            if (concertDate.getTime() === tomorrow.getTime()) {
                const subscribedUsers = await userService.getSubscribedUsers(concert.id);
                for (const user of subscribedUsers) {
                    await bot.sendMessage(user.userId, '🔔 Reminder! You have a concert tomorrow:');
                    await sendConcertNotification(user.userId, concert);
                }
            }
        }
    } catch (error) {
        console.error('Error checking upcoming concerts:', error);
    }
}

async function sendConcertNotification(userId, concert) {
    try {
        const message = formatConcertMessage(concert);
        const isSubscribed = await userService.isSubscribed(userId, concert.id);

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
    } catch (error) {
        console.error(`Error sending concert notification to user ${userId}:`, error);
    }
}

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

bot.onText(/\/start/, async (msg) => {
    const userId = msg.from.id;
    try {
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
    } catch (error) {
        console.error('Error handling /start command:', error);
    }
});

bot.onText(/🎵 View all concerts/, async (msg) => {
    const userId = msg.from.id;
    try {
        await bot.sendMessage(userId, 'Loading concerts list...');
        await concertService.updateConcerts();
        const concerts = await concertService.getUpcomingConcerts();

        if (concerts.length === 0) {
            await bot.sendMessage(userId, 'No concerts available at the moment.');
            return;
        }

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
        const venues = await concertService.getVenues();
        const subscribedVenues = await userService.getSubscribedVenues(userId);

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

bot.on('callback_query', async (callbackQuery) => {
    const userId = callbackQuery.from.id;
    const data = callbackQuery.data;

    if (data.startsWith('venue_')) {
        const venue = data.replace('venue_', '');
        try {
            const isSubscribed = await userService.isSubscribedToVenue(userId, venue);

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
        } catch (error) {
            console.error(`Error handling venue callback for ${venue}:`, error);
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: 'An error occurred. Please try again later.',
                show_alert: true
            });
        }
    } else if (data.startsWith('sub_venue_')) {
        const venue = data.replace('sub_venue_', '');
        try {
            await userService.subscribeToVenue(userId, venue);
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: `Subscribed to notifications for ${venue}!`
            });

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
        } catch (error) {
            console.error(`Error subscribing to venue ${venue}:`, error);
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: 'An error occurred. Please try again later.',
                show_alert: true
            });
        }
    } else if (data.startsWith('unsub_venue_')) {
        const venue = data.replace('unsub_venue_', '');
        try {
            await userService.unsubscribeFromVenue(userId, venue);
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: `Unsubscribed from notifications for ${venue}`
            });

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
        } catch (error) {
            console.error(`Error unsubscribing from venue ${venue}:`, error);
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: 'An error occurred. Please try again later.',
                show_alert: true
            });
        }
    } else if (data.startsWith('show_venue_')) {
        const venue = data.replace('show_venue_', '');
        try {
            const concerts = await concertService.getConcertsByVenue(venue);

            if (concerts.length === 0) {
                await bot.answerCallbackQuery(callbackQuery.id, {
                    text: `No upcoming concerts found for ${venue}.`,
                    show_alert: true
                });
                return;
            }

            for (const concert of concerts) {
                await sendConcertNotification(userId, concert);
            }
            await bot.answerCallbackQuery(callbackQuery.id);
        } catch (error) {
            console.error(`Error showing concerts for venue ${venue}:`, error);
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: 'An error occurred. Please try again later.',
                show_alert: true
            });
        }
    } else if (data.startsWith('f_')) {
        const concertId = data.replace('f_', '');
        try {
            const isSubscribed = await userService.subscribeToConcert(userId, concertId);
            if (isSubscribed) {
                await bot.answerCallbackQuery(callbackQuery.id, {
                    text: 'Concert added to favorites!'
                });

                const concert = await concertService.getConcertById(concertId);
                if (concert) {
                    await updateConcertMessage(callbackQuery.message, userId, concert);
                }
            } else {
                await bot.answerCallbackQuery(callbackQuery.id, {
                    text: 'You are already subscribed to this concert.'
                });
            }
        } catch (error) {
            console.error(`Error adding concert ${concertId} to favorites for user ${userId}:`, error);
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: 'An error occurred. Please try again later.',
                show_alert: true
            });
        }
    } else if (data.startsWith('u_')) {
        const concertId = data.replace('u_', '');
        try {
            const isUnsubscribed = await userService.unsubscribeFromConcert(userId, concertId);
            if (isUnsubscribed) {
                await bot.answerCallbackQuery(callbackQuery.id, {
                    text: 'Concert removed from favorites!'
                });

                const concert = await concertService.getConcertById(concertId);
                if (concert) {
                    await updateConcertMessage(callbackQuery.message, userId, concert);
                }
            } else {
                await bot.answerCallbackQuery(callbackQuery.id, {
                    text: 'You are not subscribed to this concert.'
                });
            }
        } catch (error) {
            console.error(`Error removing concert ${concertId} from favorites for user ${userId}:`, error);
            await bot.answerCallbackQuery(callbackQuery.id, {
                text: 'An error occurred. Please try again later.',
                show_alert: true
            });
        }
    }
});

// Function to update concert message with updated subscription status
async function updateConcertMessage(message, userId, concert) {
    try {
        const newMessage = formatConcertMessage(concert);
        const isSubscribed = await userService.isSubscribed(userId, concert.id);

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
    } catch (error) {
        console.error(`Error updating concert message for user ${userId}:`, error);
    }
}

initialize().catch(console.error);