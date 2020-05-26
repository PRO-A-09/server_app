import {logger, SocketConfig, DebateConfig} from '../conf/config.js';
import {CustomNamespace} from './customnamespace.js'
import {Debate} from "../debate/debate.js";
import {dbManager} from "../database/DatabaseManager.js";
import * as TypeCheck from '../utils/typecheck.js'

/**
 * This class implements an PrivilegedNamespace that extends a CustomNamespace
 */
export class PrivilegedNamespace extends CustomNamespace {
    io;
    activeDebates;
    users;

    /**
     * Default constructor that saves the socket.io Namespace
     * @param io Socket.io server
     */
    constructor(io) {
        super(io.of(SocketConfig.PRIVILEGED_NAMESPACE));
        this.io = io;
        this.activeDebates = new Map();
        this.users = new Map();
    }

    /**
     * Starts handling for events.
     */
    startSocketHandling() {
        this.nsp.on('connection', (socket) => {
            logger.debug(`New connected socket (socketid: ${socket.id}, username: ${socket.username})`);

            // Initialize the
            this.initializeUsers(socket);

            // Register socket functions
            socket.on('getDebates', this.getDebates(socket));
            socket.on('getDebateQuestions', this.getDebateQuestions(socket));
            socket.on('getDebateSuggestions', this.getDebateSuggestions(socket));
            socket.on('newDebate', this.newDebate(socket));
            socket.on('closeDebate', this.closeDebate(socket));
            socket.on('newQuestion', this.newQuestion(socket));

            // Moderator functions
            socket.on('banUser', this.banUser(socket));
            // socket.on('unbanUser', this.unbanUser(socket));

            socket.on('approveQuestion', this.approveQuestion(socket));
            socket.on('rejectQuestion', this.rejectQuestion(socket));
        });
    }

    /**
     * Initialize the user and his attributes
     * @param socket privileged socket to initialize
     */
    initializeUsers(socket) {
        if (this.users.has(socket.username)) {
            logger.debug(`Existing user username (${socket.username})`)
            this.users.get(socket.username).socket = socket;
        } else {
            logger.debug(`New user username (${socket.username})`)
            // Store the socket and initialize attributes
            this.users.set(socket.username, {
                socket: socket,
                activeDebates: new Set()
            });
        }
    }

    /**
     * Return a Debate with the corresponding id
     * @param id of the debate
     * @returns {Debate}
     */
    getActiveDebate(id) {
        // Return null if not found
        return this.activeDebates.get(id);
    }

    // This section contains the different socket io functions

    /**
     * Return the list of all debates to the callback function
     */
    getDebates = (socket) => async (callback) => {
        logger.debug(`Get debate requested from ${socket.username}`);

        if (!TypeCheck.isFunction(callback)) {
            logger.debug(`callback is not a function.`);
            return;
        }

        let debates = [];
        for (let debateId of this.users.get(socket.username).activeDebates) {
            let d = this.activeDebates.get(debateId);
            debates.push({
                debateId: d.debateID,
                title: d.title,
                description: d.description,
                closed: false
            });
        }

        logger.debug('Getting discussions from database');
        let discussions = await dbManager.getDiscussionsAdmin(socket.username);
        for (const discussion of discussions) {
            debates.push({
                debateId: discussion._id,
                title: discussion.title,
                description: discussion.description,
                closed: discussion.finishTime != null
            });
        }

        callback(debates);
    };

    /**
     * Return the list of questions for a debate to the callback function
     * debateId contains the id of the debate
     */
    getDebateQuestions = (socket) => (debateId, callback) => {
        logger.info(`getDebateQuestions requested from ${socket.username}`);

        if (!TypeCheck.isFunction(callback)) {
            logger.debug(`callback is not a function.`);
            return;
        }

        if (!TypeCheck.isInteger(debateId)) {
            logger.debug('Invalid arguments for getQuestions.');
            callback(-1);
            return;
        }

        const debate = this.getActiveDebate(debateId);
        if (debate == null) {
            logger.debug(`Debate with id (${debateId}) not found.`);
            callback(-1);
            return;
        }

        callback(Array.from(debate.questions.values(), q => (q.format())));
    };

    /**
     * Return the list of suggestions for a debate to the callback function
     * debateId contains the id of the debate
     */
    getDebateSuggestions = (socket) => (debateId, callback) => {
        logger.info(`getDebateSuggestions requested from ${socket.username}`);

        if (!TypeCheck.isFunction(callback)) {
            logger.debug(`callback is not a function.`);
            return;
        }

        if (!TypeCheck.isInteger(debateId)) {
            logger.debug('Invalid arguments for getDebateSuggestions.');
            callback(-1);
            return;
        }

        const debate = this.getActiveDebate(debateId);
        if (debate == null) {
            logger.debug(`Debate with id (${debateId}) not found.`);
            callback(-1);
            return;
        }

        callback(debate.questionSuggestion.getApprovedSuggestions());
    };

    /**
     * Create a new debate
     * newDebateObj contains the information of the debate (title, description)
     */
    newDebate = (socket) => async (newDebateObj, callback) => {
        logger.info(`New debate creation requested from ${socket.username}`);

        if (!TypeCheck.isFunction(callback)) {
            logger.debug(`callback is not a function.`);
            return;
        }

        const title = newDebateObj.title;
        const description = newDebateObj.description;
        if (!TypeCheck.isString(title, DebateConfig.MAX_TITLE_LENGTH) ||
            !TypeCheck.isString(description, DebateConfig.MAX_DESCRIPTION_LENGTH)) {
            logger.debug('Invalid arguments for newDebate.');
            callback(-1);
            return;
        }

        // Create and start a new debate
        const debate = new Debate(title, description, socket, this.io, this.nsp);
        this.activeDebates.set(debate.debateID, debate);
        this.users.get(socket.username).activeDebates.add(debate.debateID);
        await dbManager.saveDiscussion(debate)
            .then(res => {
                if (res === true) {
                    logger.info('Debate saved to db');
                } else {
                    logger.warn('Cannot save debate to db');
                }
            })
            .catch(res => {
                logger.error(`saveDiscussion threw : ${res}.`)
            });

        debate.startSocketHandling();
        callback(debate.debateID);
    };

    /**
     * Return the true if the debate was closed correctly false otherwise in the callback function
     */
    closeDebate = (socket) => async (aIdDiscussion, callback) => {
        logger.debug(`Close debate requested from ${socket.username}`);

        if (!(callback instanceof Function)) {
            logger.debug(`callback is not a function.`);
            return;
        }

        // Get the debate with the desired id
        let debate = this.getActiveDebate(aIdDiscussion);
        logger.debug(`Debate given ${debate}`);
        // If the debate does not exist it cannot be closed
        if(debate == null){
            callback(false);
            logger.debug(`No active debate with the id ${aIdDiscussion} was found`);
            return;
        }
        // Delete debate from active debates
        this.activeDebates.delete(aIdDiscussion);
        this.users.get(socket.username).activeDebates.delete(debate.debateID);
        // Save in the database that the discussion is closed
        let update = await dbManager.saveEndDiscussion(aIdDiscussion);

        logger.debug(`result update: ${update}`);

        callback(update);
    };

    /**
     * Add a new question to the specified debate
     * newQuestionObj contains the required information (debateId, title, answers, (optional) isOpenQuestion)
     */
    newQuestion = (socket) => async (newQuestionObj, callback) => {
        logger.debug(`newQuestion received from user (${socket.username}), id(${socket.id})`);

        if (!TypeCheck.isFunction(callback)) {
            logger.debug(`callback is not a function.`);
            return;
        }

        const debateId = newQuestionObj.debateId;
        const title = newQuestionObj.title;
        let answers = newQuestionObj.answers;
        let isOpenQuestion = newQuestionObj.isOpenQuestion;

        // Check if this is an open question, if this is an open question, ignore answers
        if (!TypeCheck.isBoolean(isOpenQuestion)) {
            isOpenQuestion = false;
        } else if (isOpenQuestion === true) {
            answers = [];
        }

        // Check debateId, title, answers
        if (!TypeCheck.isInteger(debateId) || !TypeCheck.isString(title) ||
            !TypeCheck.isArrayOf(answers, TypeCheck.isString, DebateConfig.MAX_CLOSED_ANSWERS)) {
            logger.debug('Invalid arguments for newQuestion.');
            callback(-1);
            return;
        }

        const debate = this.getActiveDebate(debateId);
        if (debate == null) {
            logger.debug(`Debate with id (${debateId}) not found.`);
            callback(-1);
            return;
        }

        const question = new debate.Question(title, answers, isOpenQuestion);

        await debate.sendNewQuestion(question);
        callback(question.id);
    };

    /**
     * Ban a user from all admin future debates and kick him immediately if debateId is specified
     * banObj contains the required information (uuid and debateId)
     */
    banUser = (socket) => (banObj, callback) => {
        logger.debug(`banUser received from user (${socket.username}), id(${socket.id})`);

        if (!TypeCheck.isFunction(callback)) {
            logger.debug(`callback is not a function.`);
            return;
        }

        let {uuid, debateId} = banObj;
        if (!TypeCheck.isString(uuid) || !TypeCheck.isInteger(debateId)) {
            logger.debug('Invalid arguments for banUser');
            callback(false);
            return;
        }

        const debate = this.getActiveDebate(debateId);
        if (debate == null) {
            logger.warn(`Debate with id (${debateId}) not found.`);
            callback(false);
            return;
        }

        // ban user to db

        // kick him

        logger.info(`User (${socket.username}) approved suggestion with id (${suggestionId})`);
        callback(true);
    };

    /**
     * Approve a suggestion with the specified id and debate
     * approveObj contains the required information (debateId and suggestionId)
     */
    approveQuestion = (socket) => (approveObj, callback) => {
        logger.debug(`approveQuestion received from user (${socket.username}), id(${socket.id})`);

        if (!TypeCheck.isFunction(callback)) {
            logger.debug(`callback is not a function.`);
            return;
        }

        let {suggestionId, debateId} = approveObj;
        if (!TypeCheck.isInteger(suggestionId) || !TypeCheck.isInteger(debateId)) {
            logger.debug('Invalid arguments for approveSuggestion');
            callback(false);
            return;
        }

        const debate = this.getActiveDebate(debateId);
        if (debate == null) {
            logger.debug(`Debate with id (${debateId}) not found.`);
            callback(false);
            return;
        }

        const res = debate.questionSuggestion.approveSuggestion(suggestionId);
        if (res === false) {
            logger.debug('Cannot approve suggestion.');
            callback(false);
            return;
        }

        logger.info(`User (${socket.username}) approved suggestion with id (${suggestionId})`);
        callback(true);
    };

    /**
     * Reject a suggestion with the specified id and debate
     * rejectObj contains the required information (debateId and suggestionId)
     */
    rejectQuestion = (socket) => (rejectObj, callback) => {
        logger.debug(`rejectQuestion received from user (${socket.username}), id(${socket.id})`);

        if (!TypeCheck.isFunction(callback)) {
            logger.debug(`callback is not a function.`);
            return;
        }

        let {suggestionId, debateId} = rejectObj;
        if (!TypeCheck.isInteger(suggestionId) || !TypeCheck.isInteger(debateId)) {
            logger.debug('Invalid arguments for rejectQuestion');
            callback(false);
            return;
        }

        const debate = this.getActiveDebate(debateId);
        if (debate == null) {
            logger.debug(`Debate with id (${debateId}) not found.`);
            callback(false);
            return;
        }

        const res = debate.questionSuggestion.rejectSuggestion(suggestionId);
        if (res === false) {
            logger.debug('Cannot reject suggestion.');
            callback(false);
            return;
        }

        logger.info(`User (${socket.username}) rejected suggestion with id (${suggestionId})`);
        callback(true);
    }
}