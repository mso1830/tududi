const https = require('https');

// Helper function to make an HTTPS POST request
const makePost = (url, body) => {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(body);
        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
            },
        };
        const req = https.request(url, options, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
};

// Helper function to get bot info from Telegram API
async function getBotInfo(token) {
    return new Promise((resolve, reject) => {
        const url = `https://api.telegram.org/bot${token}/getMe`;

        const options = {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
        };

        const req = https.request(url, options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    if (response.ok) {
                        resolve(response.result);
                    } else {
                        console.error(
                            'Telegram API error:',
                            response.description
                        );
                        resolve(null);
                    }
                } catch (error) {
                    console.error('Error parsing Telegram response:', error);
                    resolve(null);
                }
            });
        });

        req.on('error', (error) => {
            console.error('Error getting bot info:', error);
            resolve(null);
        });

        req.end();
    });
}

// Send a message with inline keyboard buttons
// buttons: array of rows, each row is array of { text, callback_data }
async function sendMessageWithButtons(token, chatId, text, buttons) {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    return makePost(url, {
        chat_id: chatId,
        text,
        reply_markup: { inline_keyboard: buttons },
    });
}

// Acknowledge a callback query to clear Telegram's loading spinner
async function answerCallbackQuery(token, callbackQueryId) {
    const url = `https://api.telegram.org/bot${token}/answerCallbackQuery`;
    return makePost(url, { callback_query_id: callbackQueryId });
}

module.exports = { getBotInfo, sendMessageWithButtons, answerCallbackQuery };
