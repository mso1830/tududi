const { User, InboxItem, Task } = require('../../../models');
const telegramPoller = require('../../../modules/telegram/telegramPoller');
const telegramInboxAssistantService = require('../../../modules/telegram/telegramInboxAssistantService');
const https = require('https');

// Mock the database models
jest.mock('../../../models', () => ({
    User: {
        update: jest.fn(),
        findAll: jest.fn(),
        findOne: jest.fn(),
    },
    InboxItem: {
        create: jest.fn(),
        findOne: jest.fn(),
    },
    Task: {
        create: jest.fn(),
        STATUS: {
            NOT_STARTED: 0,
        },
    },
}));

jest.mock('../../../modules/telegram/telegramInboxAssistantService', () => ({
    analyzeTelegramInboxItem: jest.fn(),
}));

// Mock https module
jest.mock('https', () => ({
    get: jest.fn(),
    request: jest.fn(),
}));

describe('TelegramPoller Duplicate Prevention', () => {
    let mockUser;

    beforeEach(() => {
        jest.clearAllMocks();

        mockUser = {
            id: 1,
            telegram_bot_token: 'test-token',
            telegram_chat_id: '123456789',
        };

        InboxItem.findOne.mockResolvedValue(null);
        InboxItem.create.mockImplementation(async (payload) => ({
            uid: 'inbox-1',
            ...payload,
            update: jest.fn().mockResolvedValue(true),
        }));
        Task.create.mockResolvedValue({ id: 99, uid: 'task-uid-99' });
        telegramInboxAssistantService.analyzeTelegramInboxItem.mockResolvedValue({
            status: 'ready_to_approve',
            summary: 'Draft plan',
            approval_message: 'Approve this plan?',
            subtasks: [
                {
                    name: 'First step',
                    difficulty: 'easy',
                    time_estimate: '10-15 min',
                    context: 'Get started',
                },
            ],
        });

        // Reset poller state
        telegramPoller.stopPolling();
        if (telegramPoller._clearPendingActionsForTests) {
            telegramPoller._clearPendingActionsForTests();
        }
    });

    describe('Update ID Tracking', () => {
        test('should filter out already processed updates', () => {
            const updates = [
                {
                    update_id: 100,
                    message: {
                        text: 'Hello 1',
                        message_id: 1,
                        chat: { id: 123 },
                    },
                },
                {
                    update_id: 101,
                    message: {
                        text: 'Hello 2',
                        message_id: 2,
                        chat: { id: 123 },
                    },
                },
                {
                    update_id: 102,
                    message: {
                        text: 'Hello 3',
                        message_id: 3,
                        chat: { id: 123 },
                    },
                },
            ];

            // Test internal function for filtering
            const processedUpdates = new Set(['1-100', '1-101']);
            const newUpdates = updates.filter((update) => {
                const updateKey = `1-${update.update_id}`;
                return !processedUpdates.has(updateKey);
            });

            expect(newUpdates).toHaveLength(1);
            expect(newUpdates[0].update_id).toBe(102);
        });

        test('should track highest update ID correctly', () => {
            const updates = [
                { update_id: 98 },
                { update_id: 101 },
                { update_id: 99 },
            ];

            const highestUpdateId = telegramPoller._getHighestUpdateId(updates);
            expect(highestUpdateId).toBe(101);
        });

        test('should handle empty updates array', () => {
            const highestUpdateId = telegramPoller._getHighestUpdateId([]);
            expect(highestUpdateId).toBe(0);
        });
    });

    describe('User List Management', () => {
        test('should not add duplicate users', () => {
            const users = [{ id: 1, name: 'User 1' }];
            const newUser = { id: 1, name: 'User 1 Updated' };

            const userExists = telegramPoller._userExistsInList(users, 1);
            expect(userExists).toBe(true);

            const updatedUsers = telegramPoller._addUserToList(users, newUser);
            expect(updatedUsers).toHaveLength(1);
            expect(updatedUsers).toEqual(users); // Should return original array unchanged
        });

        test('should add new users correctly', () => {
            const users = [{ id: 1, name: 'User 1' }];
            const newUser = { id: 2, name: 'User 2' };

            const userExists = telegramPoller._userExistsInList(users, 2);
            expect(userExists).toBe(false);

            const updatedUsers = telegramPoller._addUserToList(users, newUser);
            expect(updatedUsers).toHaveLength(2);
            expect(updatedUsers).toContain(newUser);
        });

        test('should remove users correctly', () => {
            const users = [
                { id: 1, name: 'User 1' },
                { id: 2, name: 'User 2' },
                { id: 3, name: 'User 3' },
            ];

            const updatedUsers = telegramPoller._removeUserFromList(users, 2);
            expect(updatedUsers).toHaveLength(2);
            expect(updatedUsers.find((u) => u.id === 2)).toBeUndefined();
            expect(updatedUsers.find((u) => u.id === 1)).toBeDefined();
            expect(updatedUsers.find((u) => u.id === 3)).toBeDefined();
        });
    });

    describe('Message Parameters', () => {
        test('should create message parameters without reply', () => {
            const params = telegramPoller._createMessageParams(
                '123',
                'Hello World'
            );
            expect(params).toEqual({
                chat_id: '123',
                text: 'Hello World',
            });
        });

        test('should create message parameters with reply', () => {
            const params = telegramPoller._createMessageParams(
                '123',
                'Hello World',
                456
            );
            expect(params).toEqual({
                chat_id: '123',
                text: 'Hello World',
                reply_to_message_id: 456,
            });
        });
    });

    describe('Telegram URL Creation', () => {
        test('should create URL without parameters', () => {
            const url = telegramPoller._createTelegramUrl('token123', 'getMe');
            expect(url).toBe('https://api.telegram.org/bottoken123/getMe');
        });

        test('should create URL with parameters', () => {
            const url = telegramPoller._createTelegramUrl(
                'token123',
                'getUpdates',
                {
                    offset: '100',
                    timeout: '30',
                }
            );
            expect(url).toBe(
                'https://api.telegram.org/bottoken123/getUpdates?offset=100&timeout=30'
            );
        });
    });

    describe('State Management', () => {
        test('should return correct initial state', () => {
            const state = telegramPoller._createPollerState();
            expect(state).toEqual({
                running: false,
                interval: null,
                pollInterval: 5000,
                usersToPool: [],
                userStatus: {},
                processedUpdates: expect.any(Set),
                userErrorState: {},
            });
        });

        test('should track poller status correctly', () => {
            const status = telegramPoller.getStatus();
            expect(status).toEqual({
                running: false,
                usersCount: 0,
                pollInterval: 5000,
                userStatus: {},
            });
        });
    });
});

describe('Telegram AI Inbox Assistant', () => {
    const createHttpsRequestMock = () => {
        let lastBody = null;

        https.request.mockImplementation((url, options, callback) => {
            const mockResponse = {
                on: jest.fn((event, handler) => {
                    if (event === 'data') handler(JSON.stringify({ ok: true }));
                    if (event === 'end') handler();
                    return mockResponse;
                }),
            };

            callback(mockResponse);

            return {
                on: jest.fn(),
                write: jest.fn((data) => {
                    lastBody = JSON.parse(data);
                }),
                end: jest.fn(),
            };
        });

        return {
            getLastBody: () => lastBody,
        };
    };

    beforeEach(() => {
        telegramPoller._clearPendingActionsForTests();
        InboxItem.findOne.mockResolvedValue(null);
        InboxItem.create.mockImplementation(async (payload) => ({
            uid: 'inbox-telegram-1',
            ...payload,
            update: jest.fn().mockResolvedValue(true),
        }));
    });

    test('asks for approval with difficulty and time estimates for clear messages', async () => {
        const requestMock = createHttpsRequestMock();
        telegramInboxAssistantService.analyzeTelegramInboxItem.mockResolvedValue({
            status: 'ready_to_approve',
            summary: 'Draft fundraising plan',
            approval_message: 'Approve this breakdown and I will create it in tududi.',
            subtasks: [
                {
                    name: 'Reserve the venue',
                    difficulty: 'medium',
                    time_estimate: '20-40 min',
                    context: 'Confirm the capacity and date.',
                },
            ],
        });

        await telegramPoller._processMessage(
            {
                id: 5,
                telegram_bot_token: 'test-token',
                telegram_chat_id: '333',
            },
            {
                message: {
                    from: { id: 1, username: 'tester' },
                    chat: { id: 333 },
                    text: 'Plan PTA fundraiser for May 10 with sponsors and volunteers',
                    message_id: 42,
                },
            }
        );

        expect(InboxItem.create).toHaveBeenCalled();
        expect(requestMock.getLastBody().text).toContain('Reply APPROVE');
        expect(requestMock.getLastBody().text).toContain('difficulty: medium');
        expect(requestMock.getLastBody().text).toContain('time: 20-40 min');

        const pending = telegramPoller._getPendingActionForTests(5, '333');
        expect(pending.stage).toBe('approval');
        expect(pending.plan.subtasks).toHaveLength(1);
    });

    test('asks a clarification question for vague messages', async () => {
        const requestMock = createHttpsRequestMock();
        telegramInboxAssistantService.analyzeTelegramInboxItem.mockResolvedValue({
            status: 'clarification_needed',
            clarification_question:
                'What exactly do you want done, and what deadline matters here?',
        });

        await telegramPoller._processMessage(
            {
                id: 6,
                telegram_bot_token: 'test-token',
                telegram_chat_id: '444',
            },
            {
                message: {
                    from: { id: 1, username: 'tester' },
                    chat: { id: 444 },
                    text: 'Handle this soon',
                    message_id: 43,
                },
            }
        );

        expect(requestMock.getLastBody().text).toContain('I need one quick clarification');
        expect(requestMock.getLastBody().text).toContain('What exactly do you want done');

        const pending = telegramPoller._getPendingActionForTests(6, '444');
        expect(pending.stage).toBe('clarification');
    });

    test('creates a parent task and subtasks when user approves', async () => {
        const requestMock = createHttpsRequestMock();
        const inboxUpdate = jest.fn().mockResolvedValue(true);
        InboxItem.create.mockResolvedValue({
            uid: 'inbox-approval-1',
            update: inboxUpdate,
        });
        Task.create
            .mockResolvedValueOnce({ id: 200, uid: 'parent-uid-200' })
            .mockResolvedValueOnce({ id: 201, uid: 'subtask-uid-1' })
            .mockResolvedValueOnce({ id: 202, uid: 'subtask-uid-2' });

        telegramInboxAssistantService.analyzeTelegramInboxItem.mockResolvedValue({
            status: 'ready_to_approve',
            summary: 'Launch checklist',
            approval_message: 'Approve this breakdown and I will create it in tududi.',
            subtasks: [
                {
                    name: 'Draft launch brief',
                    difficulty: 'easy',
                    time_estimate: '10-15 min',
                    context: 'Include goal and owner.',
                },
                {
                    name: 'Coordinate launch assets',
                    difficulty: 'medium',
                    time_estimate: '20-40 min',
                    context: 'Confirm copy and images.',
                },
            ],
        });

        const user = {
            id: 7,
            telegram_bot_token: 'test-token',
            telegram_chat_id: '555',
        };

        await telegramPoller._processMessage(user, {
            message: {
                from: { id: 1, username: 'tester' },
                chat: { id: 555 },
                text: 'Launch the new landing page campaign next week',
                message_id: 44,
            },
        });

        await telegramPoller._processMessage(user, {
            message: {
                from: { id: 1, username: 'tester' },
                chat: { id: 555 },
                text: 'APPROVE',
                message_id: 45,
            },
        });

        expect(Task.create).toHaveBeenCalledTimes(3);
        expect(Task.create).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                name: 'Launch the new landing page campaign next week',
                user_id: 7,
            })
        );
        expect(Task.create).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                name: 'Draft launch brief',
                parent_task_id: 200,
            })
        );
        expect(inboxUpdate).toHaveBeenCalledWith({ status: 'processed' });
        expect(requestMock.getLastBody().text).toContain('Created task');
        expect(telegramPoller._getPendingActionForTests(7, '555')).toBeUndefined();
    });
});
