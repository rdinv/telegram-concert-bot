const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const path = require('path');
const config = require('../config');
const { pool } = require('../db');

class ConcertService {
    constructor() {
        this.concerts = [];
        this.lastUpdate = null;
    }

    async initialize() {
        try {
            await this.loadConcertsFromCache();
            await this.updateConcerts();
        } catch (error) {
            console.error('Error initializing concert service:', error);
        }
    }

    async loadConcertsFromCache() {
        try {
            const data = await fs.readFile(config.cache.concertDataFile, 'utf8');
            this.concerts = JSON.parse(data);
            this.lastUpdate = new Date();
        } catch (error) {
            console.log('No cached concert data found');
        }
    }

    async saveConcertsToCache(concerts) {
        const connection = await pool.getConnection();
        try {
            await connection.query('TRUNCATE TABLE concerts');
            const insertPromises = concerts.map(concert => {
                const formattedDate = new Date(concert.date).toISOString().slice(0, 19).replace('T', ' '); // Format to 'YYYY-MM-DD HH:MM:SS'
                return connection.query(
                    `INSERT INTO concerts (id, title, date, venue, price, poster, subscribers, artists)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        concert.id,
                        concert.title,
                        formattedDate,
                        concert.venue,
                        concert.price,
                        concert.poster,
                        JSON.stringify(concert.subscribers || []),
                        JSON.stringify(concert.artists || []) // Сохраняем артистов в формате JSON
                    ]
                );
            });
            await Promise.all(insertPromises);
        } finally {
            connection.release();
        }
    }

    async removePastConcerts() {
        const connection = await pool.getConnection();
        try {
            console.log('Removing past concerts...');
            
            // Get IDs of past concerts
            const [pastConcerts] = await connection.query(
                'SELECT id FROM concerts WHERE date < NOW()'
            );
            const pastConcertIds = pastConcerts.map(concert => concert.id);

            if (pastConcertIds.length > 0) {
                // Remove past concerts
                const [result] = await connection.query(
                    'DELETE FROM concerts WHERE id IN (?)',
                    [pastConcertIds]
                );
                console.log(`Removed ${result.affectedRows} past concerts.`);

                // Remove references to past concerts in users' lastNotifiedConcerts
                const [userUpdateResult] = await connection.query(
                    `UPDATE users 
                     SET lastNotifiedConcerts = JSON_REMOVE(lastNotifiedConcerts, 
                         ${pastConcertIds.map((_, i) => `'$[${i}]'`).join(', ')})
                     WHERE JSON_CONTAINS(lastNotifiedConcerts, ?)`,
                    [JSON.stringify(pastConcertIds)]
                );
                console.log(`Updated ${userUpdateResult.affectedRows} users to remove past concerts from lastNotifiedConcerts.`);
            } else {
                console.log('No past concerts found to remove.');
            }
        } catch (error) {
            console.error('Error removing past concerts:', error);
        } finally {
            connection.release();
        }
    }

    async updateConcerts() {
        try {
            // Удаляем прошедшие концерты
            await this.removePastConcerts();

            const [chemiefabrikEvents, alterSchlachthofEvents, jungeGardeEvents] = await Promise.all([
                this.fetchChemiefabrikEvents(),
                this.fetchAlterSchlachthofEvents(),
                this.fetchJungeGardeEvents()
            ]);

            console.log('Fetched events:', {
                chemiefabrik: chemiefabrikEvents?.length,
                alterSchlachthof: alterSchlachthofEvents?.length,
                jungeGarde: jungeGardeEvents?.length
            });

            // Создаем Map из существующих концертов для быстрого поиска
            const existingConcertsMap = new Map();
            
            // Сначала добавляем все концерты в Map, кроме устаревших Chemiefabrik
            for (const concert of this.concerts) {
                if (concert.venue === 'Chemiefabrik' && concert.id.startsWith('chemiefabrik-')) {
                    continue;
                }
                existingConcertsMap.set(concert.id, concert);
            }

            // Обрабатываем новые концерты
            const processedConcerts = [
                ...this.processChemiefabrikEvents(chemiefabrikEvents || []),
                ...this.processAlterSchlachthofEvents(alterSchlachthofEvents || []),
                ...this.processJungeGardeEvents(jungeGardeEvents || [])
            ];

            console.log('Processed concerts:', processedConcerts.length);

            // Обновляем существующие и добавляем новые концерты
            for (const newConcert of processedConcerts) {
                if (!newConcert || !newConcert.id) {
                    console.error('Invalid concert object:', newConcert);
                    continue;
                }

                // Для концертов Chemiefabrik проверяем оба формата ID
                let existingConcert = existingConcertsMap.get(newConcert.id);
                if (!existingConcert && newConcert.venue === 'Chemiefabrik') {
                    // Ищем концерт со старым форматом ID
                    const oldId = newConcert.id.replace('cf-', 'chemiefabrik-')
                        .replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
                    const oldConcert = this.concerts.find(c => c.id === oldId);
                    if (oldConcert) {
                        // Переносим подписчиков со старого концерта
                        newConcert.subscribers = oldConcert.subscribers || [];
                        console.log(`Migrated subscribers from ${oldId} to ${newConcert.id}`);
                    }
                }

                // Обновляем или добавляем концерт
                existingConcertsMap.set(newConcert.id, {
                    ...newConcert,
                    subscribers: existingConcert?.subscribers || newConcert.subscribers || []
                });
                console.log(`${existingConcert ? 'Updated' : 'Added'} concert: ${newConcert.id}`);
            }

            // Преобразуем Map обратно в массив и сортируем по дате
            this.concerts = Array.from(existingConcertsMap.values())
                .sort((a, b) => {
                    const dateA = new Date(a.date);
                    const dateB = new Date(b.date);
                    return dateA - dateB;
                });

            console.log(`Total concerts after update: ${this.concerts.length}`);
            
            this.lastUpdate = new Date();
            await this.saveConcertsToCache(this.concerts);
        } catch (error) {
            console.error('Error updating concerts:', error);
            throw error;
        }
    }

    async fetchChemiefabrikEvents() {
        try {
            console.log('Fetching Chemiefabrik events...');
            const { data } = await axios.get(config.concertApis.chemiefabrik);
            const $ = cheerio.load(data);
            
            let concerts = [];
            
            // Находим все концерты
            $('.elementor-element-cdc7517').each((i, el) => {
                try {
                    const $event = $(el);
                    
                    // Получаем дату
                    const date = $event.find('.elementor-element-93c9594 .jet-listing-dynamic-field__content').text().trim();
                    
                    // Получаем время начала и входа
                    const doorTime = $event.find('.elementor-element-6c7315b').text().trim();
                    const startTime = $event.find('.elementor-element-c75cd6a').text().trim();
                    
                    // Получаем цену
                    const vvkPrice = $event.find('.elementor-element-4df86c0 .jet-listing-dynamic-field__content').text().trim();
                    const akPrice = $event.find('.elementor-element-307babc .jet-listing-dynamic-field__content').text().trim();
                    const preis = `${vvkPrice}, ${akPrice}`;
                    
                    // Получаем информацию о группах
                    const $bandInfoContainer = $event.find('.elementor-element-adc63ed .jet-listing-dynamic-repeater__items');
                    let title = '';
                    const links = [];
                    
                    $bandInfoContainer.find('.jet-listing-dynamic-repeater__item').each((_, item) => {
                        const $item = $(item);
                        const $link = $item.find('.bandlink');
                        const bandName = $link.text().trim();
                        const bandUrl = $link.attr('href');
                        const fullText = $item.text().trim();
                        
                        // Добавляем полный текст в название концерта
                        title += (title ? '\n' : '') + fullText;
                        
                        // Добавляем информацию о группе в список ссылок
                        links.push({
                            text: bandName,
                            url: bandUrl || '#'
                        });
                    });
                    
                    // Получаем описание
                    const description = $event.find('.elementor-element-aa0c4be .jet-listing-dynamic-field__content').text().trim();
                    
                    // Получаем изображение
                    const image = $event.find('.jet-listing-dynamic-image img').attr('src');
                    
                    // Получаем ссылку на билеты
                    const ticketUrl = $event.find('.elementor-element-ff74167 a').attr('href');

                    if (title && date) {
                        concerts.push({
                            title,
                            date,
                            doorTime,
                            startTime,
                            image,
                            preis,
                            description,
                            ticketUrl,
                            links
                        });
                        console.log('Found concert:', { title, date, doorTime, startTime });
                    }
                } catch (error) {
                    console.error('Error parsing concert element:', error);
                }
            });

            console.log(`Parsed ${concerts.length} Chemiefabrik concerts:`, concerts);
            return concerts;
        } catch (error) {
            console.error('Error fetching Chemiefabrik events:', error);
            return [];
        }
    }

    async fetchAlterSchlachthofEvents() {
        try {
            console.log('Fetching Alter Schlachthof events...');
            const response = await axios.get(config.concertApis.alterSchlachthof);
            return response.data?.events?.others || [];
        } catch (error) {
            console.error('Error fetching Alter Schlachthof events:', {
                message: error.message,
                response: error.response?.data,
                status: error.response?.status
            });
            return [];
        }
    }

    async fetchJungeGardeEvents() {
        try {
            console.log('Fetching Junge Garde events...');
            const response = await axios.get(config.concertApis.jungeGarde);
            return response.data?.events?.others || [];
        } catch (error) {
            console.error('Error fetching Junge Garde events:', {
                message: error.message,
                response: error.response?.data,
                status: error.response?.status
            });
            return [];
        }
    }

    processChemiefabrikEvents(events) {
        if (!Array.isArray(events)) {
            console.log('Chemiefabrik events is not an array:', events);
            return [];
        }

        return events.map(event => {
            try {
                console.log('Processing Chemiefabrik event:', event);

                // Парсим дату
                const dateStr = event.date.replace(/\s+/g, ' ').trim();
                let eventDate = new Date();
                
                // Пробуем разные форматы даты
                const formats = [
                    /(\w+)\.\s*(\d{1,2})\.(\d{1,2})\.(\d{2,4})/,    // Day. DD.MM.YY(YY)
                    /(\d{1,2})\.(\d{1,2})\.(\d{4})/,                 // DD.MM.YYYY
                    /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{2,4})/         // DD. MM. YY(YY)
                ];

                let matched = false;
                for (const format of formats) {
                    const match = dateStr.match(format);
                    if (match) {
                        const groups = match.slice(1);
                        if (groups.length === 3) {
                            // Формат DD.MM.YYYY
                            let year = parseInt(groups[2]);
                            if (year < 100) year += 2000;
                            eventDate = new Date(
                                year,
                                parseInt(groups[1]) - 1,
                                parseInt(groups[0])
                            );
                            matched = true;
                            break;
                        } else if (groups.length === 4) {
                            // Формат Day. DD.MM.YYYY
                            let year = parseInt(groups[3]);
                            if (year < 100) year += 2000;
                            eventDate = new Date(
                                year,
                                parseInt(groups[2]) - 1,
                                parseInt(groups[1])
                            );
                            matched = true;
                            break;
                        }
                    }
                }

                if (!matched) {
                    console.error('Could not parse date:', dateStr);
                    return null;
                }

                // Парсим время
                let startTime = '';
                let doorTime = '';
                
                if (event.startTime) {
                    const startMatch = event.startTime.match(/(\d{1,2}):(\d{2})/);
                    if (startMatch) {
                        eventDate.setHours(parseInt(startMatch[1]), parseInt(startMatch[2]));
                        startTime = `${startMatch[1]}:${startMatch[2]}`;
                    }
                }
                
                if (event.doorTime) {
                    const doorMatch = event.doorTime.match(/(\d{1,2}):(\d{2})/);
                    if (doorMatch) {
                        doorTime = `${doorMatch[1]}:${doorMatch[2]}`;
                    }
                }

                // Создаем стабильный ID на основе даты и названия первой группы
                const dateString = eventDate.toISOString().split('T')[0];
                const firstBandName = event.links[0]?.text || event.title.split('\n')[0];
                const titleHash = firstBandName.toLowerCase()
                    .replace(/[^a-z0-9]/g, '')
                    .substring(0, 15); // Сокращаем до 15 символов
                const concertId = `cf-${dateString.replace(/-/g, '')}-${titleHash}`;
                
                console.log(`Generated concert ID: ${concertId} for date ${eventDate.toISOString()}`);

                // Создаем список артистов из ссылок
                const artists = event.links.map(link => ({
                    name: link.text,
                    link: link.url
                }));

                // Убедимся, что если артистов нет, это не приводит к ошибкам
                const concert = {
                    id: concertId,
                    title: event.title,
                    date: eventDate.toISOString(),
                    venue: 'Chemiefabrik',
                    price: event.preis || 'Preis is not specified',
                    poster: event.image || null,
                    description: event.description || '',
                    location: {
                        city: 'Dresden',
                        venue: 'Chemiefabrik'
                    },
                    startTime,
                    doorTime,
                    ticketUrl: event.ticketUrl || '',
                    genreLocation: event.title,
                    artists: artists.length > 0 ? artists : [], // Убедимся, что массив артистов не пустой
                    subscribers: []
                };

                console.log('Created concert object:', concert);
                return concert;
            } catch (error) {
                console.error('Error processing Chemiefabrik event:', error, event);
                return null;
            }
        }).filter(event => event !== null);
    }

    processAlterSchlachthofEvents(events) {
        if (!Array.isArray(events)) {
            console.log('Alter Schlachthof events is not an array:', events);
            return [];
        }

        return events.map(event => {
            try {
                console.log('Processing Alter Schlachthof event:', event);

                // Парсим дату и время
                const dateParts = event.datum?.replace(/[A-Za-z,\s]+/, '')?.split('.');
                const timeParts = event.beginn?.split(':');
                let eventDate = new Date();
                if (dateParts?.length === 3 && timeParts?.length === 2) {
                    eventDate = new Date(
                        parseInt(dateParts[2]),
                        parseInt(dateParts[1]) - 1,
                        parseInt(dateParts[0]),
                        parseInt(timeParts[0]),
                        parseInt(timeParts[1])
                    );
                }

                // Формируем полный URL для изображения
                const baseUrl = 'https://www.alter-schlachthof.de';
                const imageUrl = event.img ? `${baseUrl}${event.img}` : null;

                return {
                    id: `alter-schlachthof-${event.id}`,
                    title: event.titel || 'Without title',
                    date: eventDate.toISOString(),
                    venue: 'Alter Schlachthof',
                    price: event.preis || 'Preis is not specified',
                    poster: imageUrl,
                    // Дополнительная информация
                    startTime: event.beginn || '',
                    doorTime: event.einlass || '',
                    ticketUrl: event.tickets_url || '',
                    description: event.teaser?.replace(/(<([^>]+)>)/gi, '') || '',
                    location: {
                        city: event.stadt || 'Dresden',
                        venue: event.ort || 'Alter Schlachthof'
                    },
                    facebook: event.facebook || '',
                    rawData: event, // Сохраняем оригинальные данные
                    artists: [{
                        name: event.titel || 'Without title',
                        link: event.tickets_url || event.facebook || '#'
                    }]
                };
            } catch (error) {
                console.error('Error processing Alter Schlachthof event:', error, event);
                return null;
            }
        }).filter(event => event !== null);
    }

    processJungeGardeEvents(events) {
        if (!Array.isArray(events)) {
            console.log('Junge Garde events is not an array:', events);
            return [];
        }

        return events.map(event => {
            try {
                console.log('Processing Junge Garde event:', event);

                // Парсим дату и время
                const dateParts = event.datum?.replace(/[A-Za-z,\s]+/, '')?.split('.');
                const timeParts = event.beginn?.split(':');
                let eventDate = new Date();
                if (dateParts?.length === 3 && timeParts?.length === 2) {
                    eventDate = new Date(
                        parseInt(dateParts[2]),
                        parseInt(dateParts[1]) - 1,
                        parseInt(dateParts[0]),
                        parseInt(timeParts[0]),
                        parseInt(timeParts[1])
                    );
                }

                // Формируем полный URL для изображения
                const baseUrl = 'https://www.junge-garde.com';
                const imageUrl = event.img ? `${baseUrl}${event.img}` : null;

                return {
                    id: `junge-garde-${event.id}`,
                    title: event.titel || 'Without title',
                    date: eventDate.toISOString(),
                    venue: 'Junge Garde',
                    price: event.preis || 'Preis is not specified',
                    poster: imageUrl,
                    // Дополнительная информация
                    startTime: event.beginn || '',
                    doorTime: event.einlass || '',
                    ticketUrl: event.tickets_url || '',
                    description: event.teaser?.replace(/(<([^>]+)>)/gi, '') || '',
                    location: {
                        city: event.stadt || 'Dresden',
                        venue: event.ort || 'Junge Garde'
                    },
                    facebook: event.facebook || '',
                    rawData: event, // Сохраняем оригинальные данные
                    artists: [{
                        name: event.titel || 'Without title',
                        link: event.tickets_url || event.facebook || '#'
                    }]
                };
            } catch (error) {
                console.error('Error processing Junge Garde event:', error, event);
                return null;
            }
        }).filter(event => event !== null);
    }

    async getConcertById(id) {
        const connection = await pool.getConnection();
        try {
            const [rows] = await connection.query(
                'SELECT * FROM concerts WHERE id = ?',
                [id]
            );
            if (rows.length > 0) {
                console.log('Fetched concert:', rows[0]); // Добавьте это для отладки
                return rows[0];
            }
            return null;
        } finally {
            connection.release();
        }
    }

    async getUpcomingConcerts(limit = 20) {
        const connection = await pool.getConnection();
        try {
            const [rows] = await connection.query(
                `SELECT * FROM concerts WHERE date > NOW() ORDER BY date ASC LIMIT ?`,
                [limit]
            );
            return rows;
        } finally {
            connection.release();
        }
    }

    async getUpcomingConcertsFromAPI() {
        try {
            const [chemiefabrikEvents, alterSchlachthofEvents, jungeGardeEvents] = await Promise.all([
                this.fetchChemiefabrikEvents(),
                this.fetchAlterSchlachthofEvents(),
                this.fetchJungeGardeEvents()
            ]);

            return [
                ...this.processChemiefabrikEvents(chemiefabrikEvents || []),
                ...this.processAlterSchlachthofEvents(alterSchlachthofEvents || []),
                ...this.processJungeGardeEvents(jungeGardeEvents || [])
            ];
        } catch (error) {
            console.error('Error fetching concerts from APIs:', error);
            return [];
        }
    }

    async getVenues() {
        const connection = await pool.getConnection();
        try {
            console.log('Fetching venues...');
            const [rows] = await connection.query('SELECT DISTINCT venue FROM concerts WHERE date > NOW()');
            console.log('Venues fetched:', rows);
            return rows.map(row => row.venue);
        } catch (error) {
            console.error('Error fetching venues:', error);
            return [];
        } finally {
            connection.release();
        }
    }

    getConcertsByVenue(venue) {
        const now = new Date();
        return this.concerts
            .filter(concert => concert.venue === venue && new Date(concert.date) > now)
            .sort((a, b) => {
                const dateA = new Date(a.date);
                const dateB = new Date(b.date);
                return dateA - dateB;
            });
    }

    addSubscriber(concertId, userId) {
        console.log(`Adding subscriber ${userId} to concert ${concertId}`);
        const concert = this.getConcertById(concertId);
        if (concert) {
            console.log('Found concert:', concert);
            if (!concert.subscribers) {
                concert.subscribers = [];
            }
            if (!concert.subscribers.includes(userId)) {
                concert.subscribers.push(userId);
                console.log(`Added subscriber ${userId} to concert ${concertId}`);
                this.saveConcertsToCache();
            }
        } else {
            console.log(`Concert ${concertId} not found`);
        }
    }

    removeSubscriber(concertId, userId) {
        console.log(`Removing subscriber ${userId} from concert ${concertId}`);
        const concert = this.getConcertById(concertId);
        if (concert && concert.subscribers) {
            concert.subscribers = concert.subscribers.filter(id => id !== userId);
            console.log(`Removed subscriber ${userId} from concert ${concertId}`);
            this.saveConcertsToCache();
        } else {
            console.log(`Concert ${concertId} not found or has no subscribers`);
        }
    }

    getSubscribedConcerts(userId) {
        console.log(`Getting subscribed concerts for user ${userId}`);
        const now = new Date();
        const subscribedConcerts = this.concerts
            .filter(concert => {
                const isSubscribed = concert.subscribers && concert.subscribers.includes(userId);
                const concertDate = new Date(concert.date);
                const isUpcoming = concertDate > now;
                
                console.log(`Concert ${concert.id}:`, {
                    title: concert.title,
                    date: concert.date,
                    isSubscribed,
                    isUpcoming,
                    subscribers: concert.subscribers
                });
                
                return isSubscribed && isUpcoming;
            })
            .sort((a, b) => {
                const dateA = new Date(a.date);
                const dateB = new Date(b.date);
                console.log(`Comparing dates for sorting: ${a.title} (${dateA.toISOString()}) vs ${b.title} (${dateB.toISOString()})`);
                return dateA - dateB;
            });
        
        console.log(`Found ${subscribedConcerts.length} subscribed concerts, sorted by date:`, 
            subscribedConcerts.map(c => ({
                title: c.title,
                date: new Date(c.date).toISOString()
            }))
        );
        return subscribedConcerts;
    }

    async addConcert(concert) {
        const connection = await pool.getConnection();
        try {
            // Check if the concert already exists
            const [existingConcert] = await connection.query(
                'SELECT id FROM concerts WHERE id = ?',
                [concert.id]
            );

            if (existingConcert.length > 0) {
                console.log(`Concert with ID ${concert.id} already exists. Skipping insertion.`);
                return; // Skip insertion if the concert already exists
            }

            const formattedDate = new Date(concert.date).toISOString().slice(0, 19).replace('T', ' '); // Format date
            await connection.query(
                `INSERT INTO concerts (id, title, date, venue, price, poster, subscribers, artists)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    concert.id,
                    concert.title,
                    formattedDate,
                    concert.venue,
                    concert.price,
                    concert.poster,
                    JSON.stringify(concert.subscribers || []),
                    JSON.stringify(concert.artists || []) // Save artists as JSON
                ]
            );
            console.log(`Concert ${concert.title} added to the database.`);
        } catch (error) {
            console.error('Error adding concert to database:', error);
        } finally {
            connection.release();
        }
    }
}

module.exports = new ConcertService();