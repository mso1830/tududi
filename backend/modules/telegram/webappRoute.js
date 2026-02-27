'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { User, Task, Project } = require('../../models');
const { sendTelegramMessage } = require('./telegramPoller');

const router = express.Router();

// Validate Telegram Web App initData using HMAC-SHA-256
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
const validateInitData = (initData, botToken) => {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return false;

    params.delete('hash');
    const dataCheckString = Array.from(params.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');

    const secretKey = crypto
        .createHmac('sha256', 'WebAppData')
        .update(botToken)
        .digest();

    const expectedHash = crypto
        .createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

    return expectedHash === hash;
};

// GET /telegram-datepicker — serve the mini app HTML
router.get('/telegram-datepicker', (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/telegram-datepicker.html'));
});

// POST /telegram-datepicker — receive date from mini app, update entity
router.post('/telegram-datepicker', async (req, res) => {
    const { initData, entityType, entityId, date } = req.body;

    if (!initData || !entityType || !entityId) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        // Extract the Telegram user ID from initData
        const params = new URLSearchParams(initData);
        const userStr = params.get('user');
        if (!userStr) return res.status(401).json({ error: 'No user in initData' });

        const telegramUser = JSON.parse(userStr);
        const telegramUserId = String(telegramUser.id);

        // For private chats the chat_id equals the Telegram user_id
        const user = await User.findOne({ where: { telegram_chat_id: telegramUserId } });
        if (!user || !user.telegram_bot_token) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        // Validate the HMAC signature with the user's bot token
        if (!validateInitData(initData, user.telegram_bot_token)) {
            return res.status(401).json({ error: 'Invalid signature' });
        }

        const id = parseInt(entityId, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid entity ID' });

        let entityName;
        if (entityType === 'task') {
            const task = await Task.findOne({ where: { id, user_id: user.id } });
            if (!task) return res.status(404).json({ error: 'Task not found' });
            if (date) await task.update({ due_date: new Date(date) });
            entityName = task.name;
        } else if (entityType === 'proj') {
            const project = await Project.findOne({ where: { id, user_id: user.id } });
            if (!project) return res.status(404).json({ error: 'Project not found' });
            if (date) await project.update({ due_date_at: new Date(date) });
            entityName = project.name;
        } else {
            return res.status(400).json({ error: 'Unknown entity type' });
        }

        const label = entityType === 'task' ? 'Task' : 'Project';
        const msg = `✅ ${label} "${entityName}" is all set!`;
        await sendTelegramMessage(user.telegram_bot_token, user.telegram_chat_id, msg);

        return res.json({ ok: true });
    } catch (error) {
        console.error('Telegram datepicker submit error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
