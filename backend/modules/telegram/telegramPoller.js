const https = require('https');
const { User, InboxItem, Task, Note, Project, Area } = require('../../models');

// Create poller state
const createPollerState = () => ({
    running: false,
    interval: null,
    pollInterval: 5000, // 5 seconds
    usersToPool: [],
    userStatus: {},
    processedUpdates: new Set(), // Track processed update IDs to prevent duplicates
});

// Global mutable state (managed functionally)
let pollerState = createPollerState();

// Conversation state for multi-step flows (e.g., project due-date input)
// key: `${userId}_${chatId}`, value: { type, projectId, projectName, createdAt }
const pendingConversations = new Map();
const CONVERSATION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

const setPendingConversation = (userId, chatId, data) => {
    const key = `${userId}_${chatId}`;
    pendingConversations.set(key, { ...data, createdAt: Date.now() });
};

const getPendingConversation = (userId, chatId) => {
    const key = `${userId}_${chatId}`;
    const conv = pendingConversations.get(key);
    if (!conv) return null;
    if (Date.now() - conv.createdAt > CONVERSATION_TIMEOUT_MS) {
        pendingConversations.delete(key);
        return null;
    }
    return conv;
};

const clearPendingConversation = (userId, chatId) => {
    pendingConversations.delete(`${userId}_${chatId}`);
};

// Check if user exists in list
const userExistsInList = (users, userId) => users.some((u) => u.id === userId);

// Add user to list
const addUserToList = (users, user) => {
    if (userExistsInList(users, user.id)) {
        return users;
    }
    return [...users, user];
};

// Remove user from list
const removeUserFromList = (users, userId) =>
    users.filter((u) => u.id !== userId);

// Remove user status
const removeUserStatus = (userStatus, userId) => {
    const { [userId]: removed, ...rest } = userStatus;
    return rest;
};

// Update user status
const updateUserStatus = (userStatus, userId, updates) => ({
    ...userStatus,
    [userId]: {
        ...userStatus[userId],
        ...updates,
    },
});

// Get highest update ID from updates
const getHighestUpdateId = (updates) => {
    if (!updates.length) return 0;
    return Math.max(...updates.map((u) => u.update_id));
};

// Build a unique processed update key shared across users of same bot token
const getProcessedUpdateKey = (user, updateId) => {
    const tokenPart = user.telegram_bot_token || `user-${user.id}`;
    return `${tokenPart}-${updateId}`;
};

// Create message parameters
const createMessageParams = (
    chatId,
    text,
    replyToMessageId = null,
    parseMode = undefined
) => {
    const params = { chat_id: chatId, text: text };
    if (replyToMessageId) {
        params.reply_to_message_id = replyToMessageId;
    }
    if (parseMode) {
        params.parse_mode = parseMode;
    } else if (
        typeof text === 'string' &&
        text.startsWith("📋 *Today's Task Summary*")
    ) {
        // Ensure Task Summary messages render as MarkdownV2
        params.parse_mode = 'MarkdownV2';
    }
    return params;
};

// Create Telegram API URL
const createTelegramUrl = (token, endpoint, params = {}) => {
    const baseUrl = `https://api.telegram.org/bot${token}/${endpoint}`;
    if (Object.keys(params).length === 0) return baseUrl;

    const searchParams = new URLSearchParams(params);
    return `${baseUrl}?${searchParams}`;
};

// Side effect function to make HTTP GET request
const makeHttpGetRequest = (url, timeout = 5000) => {
    return new Promise((resolve, reject) => {
        https
            .get(url, { timeout }, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);
                        resolve(response);
                    } catch (error) {
                        reject(error);
                    }
                });
            })
            .on('error', (error) => {
                reject(error);
            })
            .on('timeout', () => {
                reject(new Error('Request timeout'));
            });
    });
};

// Side effect function to make HTTP POST request
const makeHttpPostRequest = (url, postData, options) => {
    return new Promise((resolve, reject) => {
        const req = https.request(url, options, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    resolve(response);
                } catch (error) {
                    reject(error);
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
};

// Side effect function to get Telegram updates
const getTelegramUpdates = async (token, offset) => {
    try {
        // Keep a low timeout to avoid blocking HTTP server in tests/CI
        const url = createTelegramUrl(token, 'getUpdates', {
            offset: offset.toString(),
            timeout: '1',
        });

        const response = await makeHttpGetRequest(url, 5000);

        if (response.ok && Array.isArray(response.result)) {
            return response.result;
        } else {
            return [];
        }
    } catch (error) {
        throw error;
    }
};

// Side effect function to send Telegram message
const sendTelegramMessage = async (
    token,
    chatId,
    text,
    replyToMessageId = null,
    options = {}
) => {
    try {
        const messageParams = createMessageParams(
            chatId,
            text,
            replyToMessageId,
            options.parseMode
        );
        const postData = JSON.stringify(messageParams);
        const url = createTelegramUrl(token, 'sendMessage');

        const requestOptions = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
            },
        };

        return await makeHttpPostRequest(url, postData, requestOptions);
    } catch (error) {
        throw error;
    }
};

// Send a message with inline keyboard buttons
// buttons: array of rows, each row is array of { text, callback_data }
const sendTelegramMessageWithButtons = async (token, chatId, text, buttons) => {
    try {
        const postData = JSON.stringify({
            chat_id: chatId,
            text,
            reply_markup: { inline_keyboard: buttons },
        });
        const url = createTelegramUrl(token, 'sendMessage');
        const requestOptions = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
            },
        };
        return await makeHttpPostRequest(url, postData, requestOptions);
    } catch (error) {
        throw error;
    }
};

// Acknowledge a callback query to clear Telegram's loading spinner
const answerTelegramCallbackQuery = async (token, callbackQueryId) => {
    try {
        const postData = JSON.stringify({ callback_query_id: callbackQueryId });
        const url = createTelegramUrl(token, 'answerCallbackQuery');
        const requestOptions = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
            },
        };
        return await makeHttpPostRequest(url, postData, requestOptions);
    } catch (error) {
        throw error;
    }
};

// Side effect function to update user chat ID
const updateUserChatId = async (userId, chatId) => {
    await User.update({ telegram_chat_id: chatId }, { where: { id: userId } });
};

// Side effect function to create inbox item
const createInboxItem = async (content, userId, messageId) => {
    // Check if a similar item was created recently (within last 30 seconds)
    // to prevent duplicates from network issues or multiple processing
    const recentCutoff = new Date(Date.now() - 30000); // 30 seconds ago

    const existingItem = await InboxItem.findOne({
        where: {
            content: content,
            user_id: userId,
            source: 'telegram',
            created_at: {
                [require('sequelize').Op.gte]: recentCutoff,
            },
        },
    });

    if (existingItem) {
        console.log(
            `Duplicate inbox item detected for user ${userId}, content: "${content}". Skipping creation.`
        );
        return existingItem;
    }

    return await InboxItem.create({
        content: content,
        source: 'telegram',
        user_id: userId,
        metadata: { telegram_message_id: messageId }, // Store message ID for reference
    });
};

// Function to check if a Telegram user is authorized
const isAuthorizedTelegramUser = (user, message) => {
    // If no whitelist is configured, allow all users (default behavior)
    if (
        !user.telegram_allowed_users ||
        user.telegram_allowed_users.trim() === ''
    ) {
        return true;
    }

    const allowedUsers = user.telegram_allowed_users
        .split(',')
        .map((u) => u.trim().toLowerCase())
        .filter((u) => u.length > 0);

    if (allowedUsers.length === 0) {
        return true; // Empty whitelist means allow all
    }

    const fromUser = message.from;
    if (!fromUser) {
        return false; // No sender information
    }

    // Check by user ID (numeric)
    const userId = fromUser.id.toString();
    if (allowedUsers.includes(userId)) {
        return true;
    }

    // Check by username (with or without @ prefix)
    if (fromUser.username) {
        const username = fromUser.username.toLowerCase();
        if (
            allowedUsers.includes(username) ||
            allowedUsers.includes(`@${username}`)
        ) {
            return true;
        }
    }

    return false;
};

// --- Project setup flow helpers ---

const sendProjectPriorityButtons = async (token, chatId, projectId, projectName) => {
    const buttons = [[
        { text: 'Low', callback_data: `proj_priority:${projectId}:low` },
        { text: 'Medium', callback_data: `proj_priority:${projectId}:medium` },
        { text: 'High', callback_data: `proj_priority:${projectId}:high` },
        { text: 'Skip →', callback_data: `proj_priority:${projectId}:skip` },
    ]];
    await sendTelegramMessageWithButtons(
        token, chatId, `Set priority for "${projectName}":`, buttons
    );
};

const sendProjectStatusButtons = async (token, chatId, projectId) => {
    const buttons = [
        [
            { text: 'Not Started', callback_data: `proj_status:${projectId}:not_started` },
            { text: 'In Progress', callback_data: `proj_status:${projectId}:in_progress` },
        ],
        [
            { text: 'Planned', callback_data: `proj_status:${projectId}:planned` },
            { text: 'Waiting', callback_data: `proj_status:${projectId}:waiting` },
            { text: 'Skip →', callback_data: `proj_status:${projectId}:skip` },
        ],
    ];
    await sendTelegramMessageWithButtons(token, chatId, 'Set status:', buttons);
};

// --- Calendar helpers ---

const buildCalendarKeyboard = (entityType, entityId, year, month) => {
    const buttons = [];

    const monthNames = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
    ];

    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;

    const prevStr = `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
    const nextStr = `${nextYear}-${String(nextMonth).padStart(2, '0')}`;

    // Row 1: navigation
    buttons.push([
        { text: '< Prev', callback_data: `cal_nav:${entityType}:${entityId}:${prevStr}` },
        { text: `${monthNames[month - 1]} ${year}`, callback_data: 'cal_ignore' },
        { text: 'Next >', callback_data: `cal_nav:${entityType}:${entityId}:${nextStr}` },
    ]);

    // Row 2: weekday headers (Monday-first)
    buttons.push(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((day) => ({
        text: day,
        callback_data: 'cal_ignore',
    })));

    // Calculate starting offset (Monday = 0)
    const firstDayOfWeek = new Date(year, month - 1, 1).getDay(); // 0=Sun
    const startOffset = (firstDayOfWeek + 6) % 7; // 0=Mon … 6=Sun
    const daysInMonth = new Date(year, month, 0).getDate();

    let dayNum = 1;
    for (let week = 0; week < 6; week++) {
        if (dayNum > daysInMonth) break;
        const row = [];
        for (let col = 0; col < 7; col++) {
            const cellIndex = week * 7 + col;
            if (cellIndex < startOffset || dayNum > daysInMonth) {
                row.push({ text: ' ', callback_data: 'cal_ignore' });
            } else {
                const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
                row.push({
                    text: String(dayNum),
                    callback_data: `cal_day:${entityType}:${entityId}:${dateStr}`,
                });
                dayNum++;
            }
        }
        buttons.push(row);
    }

    // Final row: skip
    buttons.push([
        { text: 'Skip (no due date)', callback_data: `cal_skip:${entityType}:${entityId}` },
    ]);

    return buttons;
};

const sendCalendar = async (token, chatId, entityType, entityId, year, month) => {
    const keyboard = buildCalendarKeyboard(entityType, entityId, year, month);
    await sendTelegramMessageWithButtons(token, chatId, 'Select a due date:', keyboard);
};

// --- Project area step (calls sendCalendar for due date) ---

const sendProjectAreaButtons = async (token, chatId, projectId, userId) => {
    const areas = await Area.findAll({ where: { user_id: userId } });
    if (!areas.length) {
        // No areas — go directly to calendar
        const now = new Date();
        await sendCalendar(token, chatId, 'proj', projectId, now.getFullYear(), now.getMonth() + 1);
        return false; // signal: area step skipped
    }

    const areaButtons = areas.map((area) => ({
        text: area.name,
        callback_data: `proj_area:${projectId}:${area.id}`,
    }));

    // Group into rows of max 3
    const rows = [];
    for (let i = 0; i < areaButtons.length; i += 3) {
        rows.push(areaButtons.slice(i, i + 3));
    }
    rows.push([{ text: 'Skip →', callback_data: `proj_area:${projectId}:skip` }]);

    await sendTelegramMessageWithButtons(token, chatId, 'Set area:', rows);
    return true; // signal: area step shown
};

// --- Note helpers ---

const sendNoteProjectButtons = async (token, chatId, noteId, projects) => {
    const projectButtons = projects.map((p) => ({
        text: p.name,
        callback_data: `note_proj:${noteId}:${p.id}`,
    }));

    const rows = [];
    for (let i = 0; i < projectButtons.length; i += 3) {
        rows.push(projectButtons.slice(i, i + 3));
    }
    rows.push([{ text: 'No Project', callback_data: `note_proj:${noteId}:none` }]);

    await sendTelegramMessageWithButtons(token, chatId, 'Attach to a project?', rows);
};

// --- Task wizard helpers ---

const sendTaskPriorityButtons = async (token, chatId, taskId, taskName) => {
    const buttons = [[
        { text: 'Low', callback_data: `task_priority:${taskId}:0` },
        { text: 'Medium', callback_data: `task_priority:${taskId}:1` },
        { text: 'High', callback_data: `task_priority:${taskId}:2` },
        { text: 'Skip →', callback_data: `task_priority:${taskId}:skip` },
    ]];
    await sendTelegramMessageWithButtons(
        token, chatId, `Set priority for "${taskName}":`, buttons
    );
};

const sendTaskStatusButtons = async (token, chatId, taskId) => {
    const buttons = [
        [
            { text: 'Not Started', callback_data: `task_status:${taskId}:0` },
            { text: 'In Progress', callback_data: `task_status:${taskId}:1` },
        ],
        [
            { text: 'Planned', callback_data: `task_status:${taskId}:6` },
            { text: 'Waiting', callback_data: `task_status:${taskId}:4` },
            { text: 'Skip →', callback_data: `task_status:${taskId}:skip` },
        ],
    ];
    await sendTelegramMessageWithButtons(token, chatId, 'Set status:', buttons);
};

const sendTaskProjectButtons = async (token, chatId, taskId, userId) => {
    const projects = await Project.findAll({ where: { user_id: userId } });

    if (!projects.length) {
        const now = new Date();
        await sendCalendar(token, chatId, 'task', taskId, now.getFullYear(), now.getMonth() + 1);
        return false;
    }

    const projectButtons = projects.map((p) => ({
        text: p.name,
        callback_data: `task_project:${taskId}:${p.id}`,
    }));

    const rows = [];
    for (let i = 0; i < projectButtons.length; i += 3) {
        rows.push(projectButtons.slice(i, i + 3));
    }
    rows.push([
        { text: 'No Project', callback_data: `task_project:${taskId}:none` },
        { text: 'Skip →', callback_data: `task_project:${taskId}:skip` },
    ]);

    await sendTelegramMessageWithButtons(token, chatId, 'Attach to a project?', rows);
    return true;
};

// --- Slash command handlers ---

const handleTaskCommand = async (args, user, chatId, messageId) => {
    if (!args) {
        await sendTelegramMessage(
            user.telegram_bot_token, chatId,
            '⚠️ Usage: /task <name>\nExample: /task Buy groceries',
            messageId
        );
        return;
    }
    const task = await Task.create({ name: args, user_id: user.id, status: 0 });
    await sendTaskPriorityButtons(user.telegram_bot_token, chatId, task.id, task.name);
    console.log(`Task created via Telegram for user ${user.id}: "${args}"`);
};

const handleNoteCommand = async (args, user, chatId, messageId) => {
    if (!args) {
        await sendTelegramMessage(
            user.telegram_bot_token, chatId,
            '⚠️ Usage: /note <text>\nExample: /note Remember to call the doctor',
            messageId
        );
        return;
    }
    const note = await Note.create({ content: args, user_id: user.id });
    const projects = await Project.findAll({ where: { user_id: user.id } });
    if (!projects.length) {
        await sendTelegramMessage(user.telegram_bot_token, chatId, '✅ Note saved.', messageId);
    } else {
        await sendNoteProjectButtons(user.telegram_bot_token, chatId, note.id, projects);
    }
    console.log(`Note created via Telegram for user ${user.id}`);
};

const handleProjectCommand = async (args, user, chatId, messageId) => {
    if (!args) {
        await sendTelegramMessage(
            user.telegram_bot_token, chatId,
            '⚠️ Usage: /project <name>\nExample: /project Home Renovation Q2',
            messageId
        );
        return;
    }
    const project = await Project.create({
        name: args,
        user_id: user.id,
        status: 'not_started',
    });
    console.log(`Project created via Telegram for user ${user.id}: "${args}" (id=${project.id})`);
    await sendProjectPriorityButtons(user.telegram_bot_token, chatId, project.id, project.name);
};

// --- Callback query handler (inline button taps) ---

const processCallbackQuery = async (user, callbackQuery) => {
    const chatId = callbackQuery.message.chat.id.toString();
    const data = callbackQuery.data || '';
    const botToken = user.telegram_bot_token;

    // Authorization check
    const authMessage = { from: callbackQuery.from };
    if (!isAuthorizedTelegramUser(user, authMessage)) {
        console.log(
            `Ignoring callback from unauthorized Telegram user ${callbackQuery.from.id} for bot owner ${user.id}`
        );
        return;
    }

    // Acknowledge the callback query to clear Telegram's loading spinner
    try {
        await answerTelegramCallbackQuery(botToken, callbackQuery.id);
    } catch (e) {
        console.error('Error answering callback query:', e);
    }

    // No-op for calendar header/label buttons
    if (data === 'cal_ignore') return;

    // Parse action from first colon
    const firstColon = data.indexOf(':');
    if (firstColon === -1) return;
    const action = data.slice(0, firstColon);
    const rest = data.slice(firstColon + 1);

    try {
        // --- Calendar handlers ---

        if (action === 'cal_nav') {
            // cal_nav:<entityType>:<entityId>:<YYYY-MM>
            const parts = rest.split(':');
            if (parts.length < 3) return;
            const entityType = parts[0];
            const entityId = parseInt(parts[1], 10);
            const [year, month] = parts[2].split('-').map(Number);
            if (isNaN(entityId) || isNaN(year) || isNaN(month)) return;
            await sendCalendar(botToken, chatId, entityType, entityId, year, month);
            return;
        }

        if (action === 'cal_day') {
            // cal_day:<entityType>:<entityId>:<YYYY-MM-DD>
            const parts = rest.split(':');
            if (parts.length < 3) return;
            const entityType = parts[0];
            const entityId = parseInt(parts[1], 10);
            const date = parts[2]; // YYYY-MM-DD
            if (isNaN(entityId) || !date) return;

            if (entityType === 'task') {
                const task = await Task.findOne({ where: { id: entityId, user_id: user.id } });
                if (!task) return;
                await task.update({ due_date: new Date(date) });
                clearPendingConversation(user.id, chatId);
                await sendTelegramMessage(botToken, chatId, `✅ Task "${task.name}" is all set!`);
            } else if (entityType === 'proj') {
                const project = await Project.findOne({ where: { id: entityId, user_id: user.id } });
                if (!project) return;
                await project.update({ due_date_at: new Date(date) });
                clearPendingConversation(user.id, chatId);
                await sendTelegramMessage(botToken, chatId, `✅ Project "${project.name}" is all set!`);
            }
            return;
        }

        if (action === 'cal_skip') {
            // cal_skip:<entityType>:<entityId>
            const parts = rest.split(':');
            if (parts.length < 2) return;
            const entityType = parts[0];
            const entityId = parseInt(parts[1], 10);
            if (isNaN(entityId)) return;

            if (entityType === 'task') {
                const task = await Task.findOne({ where: { id: entityId, user_id: user.id } });
                if (!task) return;
                clearPendingConversation(user.id, chatId);
                await sendTelegramMessage(botToken, chatId, `✅ Task "${task.name}" is all set!`);
            } else if (entityType === 'proj') {
                const project = await Project.findOne({ where: { id: entityId, user_id: user.id } });
                if (!project) return;
                clearPendingConversation(user.id, chatId);
                await sendTelegramMessage(botToken, chatId, `✅ Project "${project.name}" is all set!`);
            }
            return;
        }

        // --- Note handlers ---

        if (action === 'note_proj') {
            // note_proj:<noteId>:<projectId|none>
            const secondColon = rest.indexOf(':');
            if (secondColon === -1) return;
            const noteId = parseInt(rest.slice(0, secondColon), 10);
            const projectValue = rest.slice(secondColon + 1);
            if (isNaN(noteId)) return;

            const note = await Note.findOne({ where: { id: noteId, user_id: user.id } });
            if (!note) return;

            if (projectValue !== 'none') {
                const projectId = parseInt(projectValue, 10);
                if (!isNaN(projectId)) {
                    const proj = await Project.findOne({ where: { id: projectId, user_id: user.id } });
                    if (proj) {
                        await note.update({ project_id: projectId });
                        await sendTelegramMessage(botToken, chatId, `✅ Note saved and attached to project.`);
                        return;
                    }
                }
            }
            await sendTelegramMessage(botToken, chatId, `✅ Note saved (no project).`);
            return;
        }

        // --- Task wizard handlers ---

        if (action === 'task_priority') {
            // task_priority:<taskId>:<0|1|2|skip>
            const secondColon = rest.indexOf(':');
            if (secondColon === -1) return;
            const taskId = parseInt(rest.slice(0, secondColon), 10);
            const value = rest.slice(secondColon + 1);
            if (isNaN(taskId)) return;

            const task = await Task.findOne({ where: { id: taskId, user_id: user.id } });
            if (!task) return;
            if (value !== 'skip') {
                await task.update({ priority: parseInt(value, 10) });
            }
            await sendTaskStatusButtons(botToken, chatId, taskId);
            return;
        }

        if (action === 'task_status') {
            // task_status:<taskId>:<0|1|4|6|skip>
            const secondColon = rest.indexOf(':');
            if (secondColon === -1) return;
            const taskId = parseInt(rest.slice(0, secondColon), 10);
            const value = rest.slice(secondColon + 1);
            if (isNaN(taskId)) return;

            const task = await Task.findOne({ where: { id: taskId, user_id: user.id } });
            if (!task) return;
            if (value !== 'skip') {
                await task.update({ status: parseInt(value, 10) });
            }
            await sendTaskProjectButtons(botToken, chatId, taskId, user.id);
            return;
        }

        if (action === 'task_project') {
            // task_project:<taskId>:<projectId|none|skip>
            const secondColon = rest.indexOf(':');
            if (secondColon === -1) return;
            const taskId = parseInt(rest.slice(0, secondColon), 10);
            const value = rest.slice(secondColon + 1);
            if (isNaN(taskId)) return;

            const task = await Task.findOne({ where: { id: taskId, user_id: user.id } });
            if (!task) return;

            if (value !== 'none' && value !== 'skip') {
                const projectId = parseInt(value, 10);
                if (!isNaN(projectId)) {
                    const proj = await Project.findOne({ where: { id: projectId, user_id: user.id } });
                    if (proj) {
                        await task.update({ project_id: projectId });
                    }
                }
            }

            const now = new Date();
            await sendCalendar(botToken, chatId, 'task', taskId, now.getFullYear(), now.getMonth() + 1);
            return;
        }

        // --- Project wizard handlers (proj_*) ---

        const secondColon = rest.indexOf(':');
        if (secondColon === -1) return;
        const projectId = parseInt(rest.slice(0, secondColon), 10);
        const value = rest.slice(secondColon + 1);
        if (isNaN(projectId)) return;

        let project;
        if (action.startsWith('proj_')) {
            try {
                project = await Project.findOne({ where: { id: projectId, user_id: user.id } });
            } catch (e) {
                console.error('Error finding project for callback:', e);
                return;
            }
            if (!project) {
                console.log(`Callback: project ${projectId} not found for user ${user.id}`);
                return;
            }
        }

        if (action === 'proj_priority') {
            if (value !== 'skip') {
                const priorityMap = { low: 0, medium: 1, high: 2 };
                const priority = priorityMap[value];
                if (priority !== undefined) {
                    await project.update({ priority });
                }
            }
            await sendProjectStatusButtons(botToken, chatId, projectId);

        } else if (action === 'proj_status') {
            if (value !== 'skip') {
                await project.update({ status: value });
            }
            await sendProjectAreaButtons(botToken, chatId, projectId, user.id);

        } else if (action === 'proj_area') {
            if (value !== 'skip') {
                const areaId = parseInt(value, 10);
                if (!isNaN(areaId)) {
                    await project.update({ area_id: areaId });
                }
            }
            const now = new Date();
            await sendCalendar(botToken, chatId, 'proj', projectId, now.getFullYear(), now.getMonth() + 1);
        }
    } catch (error) {
        console.error(`Error processing callback query for user ${user.id}:`, error);
        await sendTelegramMessage(botToken, chatId, `❌ Failed to process action: ${error.message}`);
    }
};

// Function to handle bot commands
const handleBotCommand = async (command, user, chatId, messageId) => {
    const botToken = user.telegram_bot_token;

    switch (command.toLowerCase()) {
        case '/start':
            await sendTelegramMessage(
                botToken,
                chatId,
                `🎉 Welcome to tududi!\n\nYour personal task management bot is now connected and ready to help!\n\n📝 Send me any text to add it to your inbox, or use commands:\n• /task <name> — Create a task\n• /note <text> — Create a note\n• /project <name> — Create a project\n• /help — Show all commands\n\nLet's get organized! 🚀`,
                messageId
            );
            break;
        case '/help':
            await sendTelegramMessage(
                botToken,
                chatId,
                `📋 tududi Bot Help\n\nCommands:\n/task <name>    - Create a task, then set priority/status/project/due date\n/note <text>    - Create a note, then optionally attach to a project\n/project <name> - Create a project (tap buttons to set details)\n/start          - Welcome message\n/help           - Show this help message\n\nOr just send any text to add it to your inbox.`,
                messageId
            );
            break;
        default:
            await sendTelegramMessage(
                botToken,
                chatId,
                `❓ Unknown command: ${command}\n\nUse /help to see available commands or just send a regular message to add it to your inbox.`,
                messageId
            );
            break;
    }
};

// Function to process a single message (contains side effects)
const processMessage = async (user, update) => {
    const message = update.message;
    const text = message.text;
    const chatId = message.chat.id.toString();
    const messageId = message.message_id;

    // Check if the user is authorized to send messages to this bot
    if (!isAuthorizedTelegramUser(user, message)) {
        console.log(
            `Ignoring message from unauthorized Telegram user ${message.from.id} (@${message.from.username || 'no_username'}) for bot owner ${user.id}`
        );
        return; // Silently ignore unauthorized users
    }

    // If allowed users list is configured allow multiple chats
    if (
        (!user.telegram_allowed_users ||
            user.telegram_allowed_users.trim() === '') &&
        user.telegram_chat_id &&
        user.telegram_chat_id !== chatId
    ) {
        return;
    }

    // Update chat ID if needed and send welcome message for new users
    if (!user.telegram_chat_id) {
        // Ensure no other user with the same bot token already owns this chat
        const existingOwner = await User.findOne({
            where: {
                telegram_bot_token: user.telegram_bot_token,
                telegram_chat_id: chatId,
            },
        });

        if (existingOwner && existingOwner.id !== user.id) {
            // Another user already owns this chat for this token; ignore
            return;
        }

        await updateUserChatId(user.id, chatId);
        user.telegram_chat_id = chatId; // Update local object

        // Send welcome message for first-time users
        await sendTelegramMessage(
            user.telegram_bot_token,
            chatId,
            `🎉 Welcome to tududi!\n\nYour personal task management bot is now connected and ready to help!\n\n📝 Simply send me any message and I'll add it to your tududi inbox as an inbox item.\n\n✨ Commands:\n• /help - Show help information\n• /start - Show welcome message\n• Just type any text - Add it as an inbox item\n\nLet's get organized! 🚀`
        );

        console.log(
            `Sent welcome message to new user ${user.id} in chat ${chatId}`
        );

        // If the first message was just /start, don't process it further
        if (text.toLowerCase() === '/start') {
            return;
        }
    }

    try {
        // 1. Handle slash commands
        if (text.startsWith('/')) {
            // Extract command and arguments
            // Strip @botname suffix Telegram sometimes appends (e.g. /note@MyBot → /note)
            const spaceIdx = text.indexOf(' ');
            const rawCommand = (spaceIdx > -1 ? text.slice(0, spaceIdx) : text).toLowerCase();
            const command = rawCommand.split('@')[0];
            const args = spaceIdx > -1 ? text.slice(spaceIdx + 1).trim() : '';

            if (command === '/task') {
                await handleTaskCommand(args, user, chatId, messageId);
            } else if (command === '/note') {
                await handleNoteCommand(args, user, chatId, messageId);
            } else if (command === '/project') {
                await handleProjectCommand(args, user, chatId, messageId);
            } else {
                await handleBotCommand(text, user, chatId, messageId);
            }
            console.log(
                `Successfully processed command ${messageId} for user ${user.id}: "${command}"`
            );
            return;
        }

        // 2. Regular text → create inbox item (with duplicate check)
        await createInboxItem(text, user.id, messageId);
        await sendTelegramMessage(
            user.telegram_bot_token,
            chatId,
            `✅ Added to tududi inbox: "${text}"`,
            messageId
        );
        console.log(
            `Successfully processed message ${messageId} for user ${user.id}: "${text}"`
        );
    } catch (error) {
        // Send error message
        await sendTelegramMessage(
            user.telegram_bot_token,
            chatId,
            `❌ Failed to process message: ${error.message}`,
            messageId
        );
    }
};

// Function to process updates (contains side effects)
const processUpdates = async (user, updates) => {
    if (!updates.length) return;

    // Filter out already processed updates
    const newUpdates = updates.filter((update) => {
        const updateKey = getProcessedUpdateKey(user, update.update_id);
        return !pollerState.processedUpdates.has(updateKey);
    });

    if (!newUpdates.length) return;

    // Get highest update ID from new updates
    const highestUpdateId = getHighestUpdateId(newUpdates);

    // Update user status
    pollerState = {
        ...pollerState,
        userStatus: updateUserStatus(pollerState.userStatus, user.id, {
            lastUpdateId: highestUpdateId,
        }),
    };

    // Process each new update
    for (const update of newUpdates) {
        try {
            const updateKey = getProcessedUpdateKey(user, update.update_id);

            if (update.message && update.message.text) {
                // Mark update as processed BEFORE processing to avoid races
                pollerState.processedUpdates.add(updateKey);
                await processMessage(user, update);
            } else if (update.callback_query) {
                pollerState.processedUpdates.add(updateKey);
                await processCallbackQuery(user, update.callback_query);
            }

            // Clean up old processed updates (keep only last 1000 to prevent memory leak)
            if (pollerState.processedUpdates.size > 1000) {
                const oldestEntries = Array.from(
                    pollerState.processedUpdates
                ).slice(0, 100);
                oldestEntries.forEach((entry) =>
                    pollerState.processedUpdates.delete(entry)
                );
            }
        } catch (error) {
            console.error(
                `Error processing update ${update.update_id} for user ${user.id}:`,
                error
            );
        }
    }
};

// Function to poll updates for all users (contains side effects)
const pollUpdates = async () => {
    for (const user of pollerState.usersToPool) {
        const token = user.telegram_bot_token;
        if (!token) continue;

        try {
            const lastUpdateId =
                pollerState.userStatus[user.id]?.lastUpdateId || 0;
            const updates = await getTelegramUpdates(token, lastUpdateId + 1);

            if (updates && updates.length > 0) {
                console.log(
                    `Processing ${updates.length} updates for user ${user.id}, starting from update ID ${lastUpdateId + 1}`
                );
                await processUpdates(user, updates);
            }
        } catch (error) {
            console.error(`Error getting updates for user ${user.id}:`, error);
        }
    }
};

// Function to start polling (contains side effects)
const startPolling = () => {
    if (pollerState.running) return;

    const interval = setInterval(async () => {
        try {
            await pollUpdates();
        } catch (error) {
            // Error polling Telegram
        }
    }, pollerState.pollInterval);

    pollerState = {
        ...pollerState,
        running: true,
        interval,
    };
};

// Function to stop polling (contains side effects)
const stopPolling = () => {
    if (!pollerState.running) return;

    if (pollerState.interval) {
        clearInterval(pollerState.interval);
    }

    pollerState = {
        ...pollerState,
        running: false,
        interval: null,
    };
};

// Function to add user (contains side effects)
const addUser = async (user) => {
    if (!user || !user.telegram_bot_token) {
        return false;
    }

    // Add user to list
    const newUsersList = addUserToList(pollerState.usersToPool, user);

    pollerState = {
        ...pollerState,
        usersToPool: newUsersList,
    };

    // Start polling if not already running and we have users
    if (pollerState.usersToPool.length > 0 && !pollerState.running) {
        startPolling();
    }

    return true;
};

// Function to remove user (contains side effects)
const removeUser = (userId) => {
    // Remove user from list and status
    const newUsersList = removeUserFromList(pollerState.usersToPool, userId);
    const newUserStatus = removeUserStatus(pollerState.userStatus, userId);

    pollerState = {
        ...pollerState,
        usersToPool: newUsersList,
        userStatus: newUserStatus,
    };

    // Stop polling if no users left
    if (pollerState.usersToPool.length === 0 && pollerState.running) {
        stopPolling();
    }

    return true;
};

// Get poller status
const getStatus = () => ({
    running: pollerState.running,
    usersCount: pollerState.usersToPool.length,
    pollInterval: pollerState.pollInterval,
    userStatus: pollerState.userStatus,
});

// Export functional interface
module.exports = {
    addUser,
    removeUser,
    startPolling,
    stopPolling,
    getStatus,
    sendTelegramMessage,
    // For testing
    _createPollerState: createPollerState,
    _userExistsInList: userExistsInList,
    _addUserToList: addUserToList,
    _removeUserFromList: removeUserFromList,
    _getHighestUpdateId: getHighestUpdateId,
    _createMessageParams: createMessageParams,
    _createTelegramUrl: createTelegramUrl,
    _isAuthorizedTelegramUser: isAuthorizedTelegramUser,
    _processMessage: processMessage,
    _processCallbackQuery: processCallbackQuery,
    _setPendingConversation: setPendingConversation,
    _getPendingConversation: getPendingConversation,
    _clearPendingConversation: clearPendingConversation,
    _buildCalendarKeyboard: buildCalendarKeyboard,
};
