require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const express = require('express');
const { Telegraf } = require('telegraf');
const { URL } = require('url');

const LOCK_FILE = 'bot.lock';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GROUP_ID = process.env.GROUP_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (!TELEGRAM_TOKEN || !GROUP_ID || !WEBHOOK_URL) {
    throw new Error('Telegram token, group ID, and webhook URL must be set.');
}

const logger = console;
const imagesDir = path.join(__dirname, 'images');
if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir);
}

const bot = new Telegraf(TELEGRAM_TOKEN);

let isBotRunning = false;

bot.on('photo', async (ctx) => {
    const chatId = ctx.message.chat.id;
    logger.info(`Received message in chat ${chatId}`);

    if (chatId.toString() === GROUP_ID) {
        const photos = ctx.message.photo;
        if (!photos) {
            logger.warn('No photos found in the message.');
            return;
        }

        const largestPhoto = photos[photos.length - 1];
        const fileId = largestPhoto.file_id;
        const file = await bot.telegram.getFile(fileId);
        const filePath = file.file_path;
        const fileUrl = new URL(filePath, `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/`);

        logger.info(`Attempting to download image from URL: ${fileUrl}`);

        try {
            await downloadImage(fileUrl.toString(), fileId);
        } catch (e) {
            logger.error(`Failed to download or save image: ${e.message} - URL: ${fileUrl}`);
        }
    } else {
        logger.info(`Message from unexpected chat: ${chatId}`);
    }
});

async function downloadImage(url, fileId) {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    const imageHash = crypto.createHash('md5').update(response.data).digest('hex');
    const filePath = path.join(imagesDir, `${imageHash}.jpg`);

    if (fs.existsSync(filePath)) {
        logger.info(`Image already exists: ${filePath}`);
        return;
    }

    fs.writeFileSync(filePath, response.data);
    logger.info(`Saved image to ${filePath}`);
}

const app = express();
app.use(express.json());

app.get('/images/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(imagesDir, filename);

    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send('Image not found');
    }
});

app.get('/random-image', async (req, res) => {
    try {
        const images = fs.readdirSync(imagesDir);
        if (!images.length) {
            logger.error('No images found in the directory.');
            return res.status(404).send('No images found');
        }
        const { default: random } = await import('random');
        const randomImage = images[random.int(0, images.length - 1)];
        res.redirect(`/images/${randomImage}`);
    } catch (e) {
        logger.error(`Exception occurred while serving random image: ${e}`, e.stack);
        res.status(500).send('An error occurred');
    }
});

app.get('/health', (req, res) => {
    res.send('OK');
});

function runExpress() {
    app.listen(5000, () => {
        logger.info('Express server running on port 5000');
    });
}

function runTelegramBot() {
    if (fs.existsSync(LOCK_FILE)) {
        logger.info('Bot is already running');
        return;
    }

    fs.writeFileSync(LOCK_FILE, '');
    const webhookUrl = `${WEBHOOK_URL}/bot${TELEGRAM_TOKEN}`;
    bot.telegram.setWebhook(webhookUrl).then(() => {
        app.use(bot.webhookCallback(`/bot${TELEGRAM_TOKEN}`));
        isBotRunning = true;
        logger.info('Telegram bot started with webhook');
    }).catch((e) => {
        logger.error(`Failed to set webhook: ${e.message}`);
        if (fs.existsSync(LOCK_FILE)) {
            fs.unlinkSync(LOCK_FILE);
        }
    });
}

runExpress();
runTelegramBot();

process.on('SIGINT', () => {
    if (isBotRunning) {
        bot.stop('SIGINT');
    }
    if (fs.existsSync(LOCK_FILE)) {
        fs.unlinkSync(LOCK_FILE);
    }
    process.exit();
});

process.on('SIGTERM', () => {
    if (isBotRunning) {
        bot.stop('SIGTERM');
    }
    if (fs.existsSync(LOCK_FILE)) {
        fs.unlinkSync(LOCK_FILE);
    }
    process.exit();
});
