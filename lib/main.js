"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const github = __importStar(require("@actions/github"));
const yaml = __importStar(require("js-yaml"));
function run() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            // Configuration parameters
            const configPath = core.getInput('configuration-path', {
                required: true
            });
            const token = core.getInput('repo-token', { required: true });
            const notBefore = Date.parse(core.getInput('not-before', { required: false }));
            const includeTitle = parseInt(core.getInput('include-title', { required: false }));
            const syncLabels = parseInt(core.getInput('sync-labels', { required: false }));
            const eventInfo = getEventInfo();
            const event_name = eventInfo.get('event_name');
            const issue_number = eventInfo.get('issue_number');
            const title = eventInfo.get('title');
            const body = eventInfo.get('body');
            const created_at = eventInfo.get('created_at');
            const author_association = eventInfo.get('author_association');
            if (core.isDebug()) {
                core.debug(`event_name: ${event_name}`);
                core.debug(`issue_number: ${issue_number}`);
                core.debug(`title: ${title}`);
                core.debug(`body: ${body}`);
                core.debug(`created_at: ${created_at}`);
                core.debug(`author_association: ${author_association}`);
            }
            // A client to load data from GitHub
            const client = github.getOctokit(token);
            if (event_name === 'push' /* || event_name === 'commit_comment'*/) {
                if (issue_number && Array.isArray(issue_number)) {
                    for (const a_issue_number of issue_number) {
                        core.notice(`This push fixed issue #${a_issue_number}.`);
                        addLabels(client, a_issue_number, ['fixed']);
                    }
                }
            }
            else {
                if (Array.isArray(issue_number)) {
                    throw Error(`unknown error`);
                }
                // If the notBefore parameter has been set to a valid timestamp,
                // exit if the current issue was created before notBefore
                if (notBefore) {
                    const createdAt = Date.parse(created_at);
                    core.info(`Issue is created at ${created_at}.`);
                    if (Number.isNaN(createdAt)) {
                        throw Error(`cannot deduce \`createdAt\` from ${created_at}`);
                    }
                    else if (createdAt < notBefore) {
                        core.notice('Issue is before `notBefore` configuration parameter. Exiting...');
                        return;
                    }
                }
                else {
                    core.debug(`Parameter \`notBefore\` is not set or is set invalid.`);
                }
                // Load our regex rules from the configuration path
                const itemsPromise = getLabelCommentArrays(client, configPath, syncLabels);
                // Get the labels have been added to the current issue
                const labelsPromise = getLabels(client, issue_number);
                const [labelParams, commentParams] = yield itemsPromise;
                const issueLabels = yield labelsPromise;
                let issueContent = '';
                if (includeTitle === 1) {
                    issueContent += `${title}\n\n`;
                }
                issueContent += body;
                core.info(`Content of issue #${issue_number}:\n${issueContent}`);
                // labels to be added & removed
                let [addLabelItems, removeLabelItems] = itemAnalyze(labelParams, issueContent, author_association, event_name);
                // comments to be added
                const addCommentItems = itemAnalyze(commentParams, issueContent, author_association, event_name)[0];
                if (core.isDebug()) {
                    core.debug(`labels have been added: [${Array.from(issueLabels)}]`);
                    core.debug(`labels to be added: [${addLabelItems.toString()}]`);
                    core.debug(`labels to be removed: [${removeLabelItems.toString()}]`);
                }
                // some may have been added, remove them
                addLabelItems = addLabelItems.filter(label => !issueLabels.has(label));
                if (addLabelItems.length > 0) {
                    core.info(`Adding labels ${addLabelItems.toString()} to issue #${issue_number}`);
                    addLabels(client, issue_number, addLabelItems);
                }
                if (syncLabels) {
                    for (const label of removeLabelItems) {
                        // skip labels that have not been added
                        if (issueLabels.has(label)) {
                            core.info(`Removing label ${label} from issue #${issue_number}`);
                            removeLabel(client, issue_number, label);
                        }
                    }
                }
                if (addCommentItems.length > 0) {
                    for (const itemBody of addCommentItems) {
                        core.info(`Comment ${itemBody} to issue #${issue_number}`);
                        addComment(client, issue_number, itemBody);
                    }
                }
            }
        }
        catch (error) {
            if (error instanceof Error) {
                core.error(error);
                core.setFailed(error.message);
            }
        }
    });
}
function itemAnalyze(itemMap, issueContent, author_association, event_name) {
    const addItems = [];
    const addItemNames = new Set();
    const removeItems = [];
    for (const itemParams of itemMap) {
        const item = itemParams.get('content');
        const itemName = itemParams.get('name');
        const globs = itemParams.get('regexes');
        const allowedAuthorAssociation = itemParams.get('author_association');
        const mode = itemParams.get('mode');
        const skipIf = itemParams.get('skip-if');
        const removeIf = itemParams.get('remove-if');
        const needAdd = checkEvent(event_name, mode, 'add');
        const needRemove = checkEvent(event_name, mode, 'remove');
        if ((needAdd || needRemove) &&
            skipIf.filter(x => addItemNames.has(x)).length === 0) {
            if (removeIf.filter(x => addItemNames.has(x)).length === 0 &&
                checkAuthorAssociation(author_association, allowedAuthorAssociation) &&
                checkRegexes(issueContent, globs)) {
                if (needAdd) {
                    // contents can be duplicated, but only added once (set content="" to skip add)
                    if (item !== '' && !addItems.includes(item)) {
                        addItems.push(item);
                    }
                    // add itemName regardless of whether the content is duplicated
                    addItemNames.add(itemName);
                }
            }
            else {
                if (needRemove) {
                    // Ibid.
                    if (item !== '' && !removeItems.includes(item)) {
                        removeItems.push(item);
                    }
                }
            }
        }
        else {
            if (core.isDebug()) {
                core.debug(`needAdd = ${needAdd}, needRemove = ${needRemove}, mode = ${JSON.stringify(Object.fromEntries(mode.entries()))}`);
                core.debug(`Ignore item \`${itemName}\`.`);
            }
        }
    }
    return [addItems.filter(item => !removeItems.includes(item)), removeItems];
}
function getEventDetails(issue, repr) {
    const eventDetails = new Map();
    try {
        eventDetails.set('issue_number', issue.number ? issue.number : NaN);
        eventDetails.set('title', issue.title ? issue.title : '');
        eventDetails.set('body', issue.body ? issue.body : '');
        eventDetails.set('author_association', issue.author_association ? issue.author_association : '');
        eventDetails.set('created_at', issue.created_at ? issue.created_at : '');
    }
    catch (error) {
        throw Error(`could not get ${repr} from context (${error})`);
    }
    return eventDetails;
}
function getIssueNumbersFromMessage(messages) {
    let issue_numbers = [];
    const globs = /(?:[Ff]ix|[Cc]lose)\s+(?:#|.*\/issues\/)(\d+)/;
    let matchResult = messages.match(globs);
    while (matchResult && matchResult.index) {
        issue_numbers.push(parseInt(RegExp.$1));
        messages = messages.substr(matchResult.index + matchResult[0].length);
        matchResult = messages.match(globs);
    }
    return issue_numbers;
}
function getPushEventDetails(payload) {
    const eventDetails = new Map();
    try {
        let messages = '';
        for (const commit of payload.commits)
            messages += `${commit.message}\n\n`;
        let issue_numbers = getIssueNumbersFromMessage(messages);
        eventDetails.set('issue_number', issue_numbers);
        eventDetails.set('title', '');
        eventDetails.set('body', messages);
        eventDetails.set('author_association', ''); // TODO
        eventDetails.set('created_at', '1970-01-01T00:00:00Z'); // TODO
    }
    catch (error) {
        throw Error(`could not get push event details from context (${error})`);
    }
    return eventDetails;
}
function getEventInfo() {
    const payload = github.context.payload;
    const event_name = github.context.eventName;
    if (event_name === 'issues') {
        const eventInfo = getEventDetails(payload.issue, 'issue');
        eventInfo.set('event_name', event_name);
        return eventInfo;
    }
    else if (event_name === 'pull_request_target' ||
        event_name === 'pull_request') {
        const eventInfo = getEventDetails(payload.pull_request, 'pull request');
        eventInfo.set('event_name', event_name);
        return eventInfo;
    }
    else if (event_name === 'issue_comment') {
        const eventInfo = getEventDetails(payload.comment, 'issue comment');
        const issue = getEventDetails(payload.issue, 'issue');
        eventInfo.set('event_name', event_name);
        eventInfo.set('issue_number', issue.get('issue_number'));
        eventInfo.set('title', issue.get('title'));
        return eventInfo;
    }
    else if (event_name === 'push') {
        const eventInfo = getPushEventDetails(payload);
        eventInfo.set('event_name', event_name);
        return eventInfo;
        // } else if (event_name === 'commit_comment') {
        //   const eventInfo: item_t = getEventDetails(payload.comment, 'commit comment')
        //   const issue_numbers: number[] = getIssueNumbersFromMessage(
        //     eventInfo.get('body')
        //   )
        //   eventInfo.set('issue_number', issue_numbers)
        //   return eventInfo
    }
    else {
        throw Error(`could not handle event \`${event_name}\``);
    }
}
function getLabelCommentArrays(client, configurationPath, syncLabels) {
    return __awaiter(this, void 0, void 0, function* () {
        const response = yield client.rest.repos.getContent({
            owner: github.context.repo.owner,
            repo: github.context.repo.repo,
            path: configurationPath,
            ref: github.context.sha
        });
        const data = response.data;
        if (!data.content) {
            throw Error(`the configuration path provides an invalid file`);
        }
        const configurationContent = Buffer.from(data.content, 'base64').toString('utf8');
        const configObject = yaml.load(configurationContent);
        // transform `any` => `item_t[]` or throw if yaml is malformed:
        return getArraysFromObject(configObject, syncLabels);
    });
}
function getItemParamsFromItem(item, default_mode) {
    const isstr = (x) => typeof x === 'string';
    const isstrarr = (x) => Array.isArray(x);
    const isnull = (x) => x === null;
    const pred_any2any = (x) => x;
    const pred_any2anyarr = (x) => [x];
    const pred_2emptystr = () => '';
    const str2str = new Map().set('cond', isstr).set('pred', pred_any2any);
    const str2strarr = new Map()
        .set('cond', isstr)
        .set('pred', pred_any2anyarr);
    const strarr2strarr = new Map()
        .set('cond', isstrarr)
        .set('pred', pred_any2any);
    const null2str = new Map()
        .set('cond', isnull)
        .set('pred', pred_2emptystr);
    const mode_cond_pred = new Map()
        .set('cond', () => true)
        .set('pred', getModeFromObject);
    const configMap = new Map([
        ['name', [str2str]],
        ['content', [str2str, null2str]],
        ['author_association', [str2strarr, strarr2strarr]],
        ['regexes', [str2strarr, strarr2strarr]],
        ['mode', [mode_cond_pred]],
        ['skip-if', [str2strarr, strarr2strarr]],
        ['remove-if', [str2strarr, strarr2strarr]]
    ]);
    const itemParams = new Map();
    for (const key in item) {
        if (configMap.has(key)) {
            const value = item[key];
            const cond_preds = configMap.get(key);
            for (const cond_pred of cond_preds) {
                const cond = cond_pred.get('cond');
                const pred = cond_pred.get('pred');
                if (typeof cond == 'function' &&
                    typeof pred == 'function' &&
                    cond(value)) {
                    itemParams.set(key, pred(value));
                    break;
                }
            }
            if (!itemParams.has(key)) {
                const itemRepr = itemParams.has('name')
                    ? itemParams.get('name')
                    : 'some item';
                throw Error(`found unexpected \`${value}\` (type \`${typeof key}\`) of field \`${key}\` in ${itemRepr}`);
            }
        }
        else {
            throw Error(`found unexpected field \`${key}\``);
        }
    }
    if (!itemParams.has('name') || !itemParams.get('name')) {
        throw Error(`some item's name is missing`);
    }
    const itemName = itemParams.get('name');
    if (!itemParams.has('content')) {
        itemParams.set('content', itemName);
    }
    if (!itemParams.has('regexes')) {
        itemParams.set('regexes', []);
    }
    if (!itemParams.has('author_association')) {
        itemParams.set('author_association', []);
    }
    if (!itemParams.has('skip-if')) {
        itemParams.set('skip-if', []);
    }
    if (!itemParams.has('remove-if')) {
        itemParams.set('remove-if', []);
    }
    if (!itemParams.has('mode')) {
        itemParams.set('mode', default_mode);
    }
    return itemParams;
}
function getModeFromObject(configObject) {
    const modeMap = new Map();
    if (typeof configObject === 'string') {
        modeMap.set(configObject, '__all__');
    }
    else if (Array.isArray(configObject)) {
        for (const value of configObject) {
            modeMap.set(value, '__all__');
        }
    }
    else {
        for (const key in configObject) {
            if (configObject[key] === null) {
                modeMap.set(key, '__all__');
            }
            else {
                modeMap.set(key, configObject[key]);
            }
        }
    }
    return modeMap;
}
function getItemArrayFromObject(configObject, default_mode) {
    const itemArray = [];
    for (const item of configObject) {
        const itemParams = getItemParamsFromItem(item, default_mode);
        itemArray.push(itemParams);
    }
    return itemArray;
}
function getArraysFromObject(configObject, syncLabels) {
    let labelParamsObject = [];
    let commentParamsObject = [];
    let labelParams = [];
    let commentParams = [];
    let default_mode = undefined;
    for (const key in configObject) {
        if (key === 'labels') {
            labelParamsObject = configObject[key];
        }
        else if (key === 'comments') {
            commentParamsObject = configObject[key];
        }
        else if (key === 'default-mode') {
            default_mode = getModeFromObject(configObject[key]);
        }
        else {
            throw Error(`found unexpected key for ${key} (should be \`labels\` or \`comments\`)`);
        }
    }
    if (default_mode === undefined) {
        if (syncLabels === 1) {
            default_mode = new Map([
                ['pull_request', ['add', 'remove']],
                ['pull_request_target', ['add', 'remove']],
                ['issue', ['add', 'remove']],
                ['issue_comment', ['add', 'remove']]
            ]);
        }
        else if (syncLabels === 0) {
            default_mode = new Map([
                ['pull_request', ['add']],
                ['pull_request_target', ['add']],
                ['issue', ['add']],
                ['issue_comment', ['add']]
            ]);
        }
        else {
            throw Error(`found unexpected value of syncLabels (${syncLabels}, should be 0 or 1)`);
        }
    }
    labelParams = getItemArrayFromObject(labelParamsObject, default_mode);
    commentParams = getItemArrayFromObject(commentParamsObject, default_mode);
    return [labelParams, commentParams];
}
function checkRegexes(body, regexes) {
    let matched;
    // If several regex entries are provided we require all of them to match for the label to be applied.
    for (const regEx of regexes) {
        const isRegEx = regEx.match(/^\/(.+)\/(.*)$/);
        if (isRegEx) {
            matched = body.match(new RegExp(isRegEx[1], isRegEx[2]));
        }
        else {
            matched = body.match(regEx);
        }
        if (!matched) {
            return false;
        }
    }
    return true;
}
function checkEvent(event_name, mode, type // "add", "remove"
) {
    const event_rule = mode.get(event_name);
    const type_rule = mode.get(type);
    return ((event_rule !== undefined &&
        (event_rule === '__all__' ||
            event_rule === type ||
            (Array.isArray(event_rule) && event_rule.includes(type)))) ||
        (type_rule !== undefined &&
            (type_rule === '__all__' ||
                type_rule === event_name ||
                (Array.isArray(type_rule) && type_rule.includes(event_name)))));
}
function checkAuthorAssociation(author_association, regexes) {
    let matched;
    // If several regex entries are provided we require all of them to match for the label to be applied.
    for (const regEx of regexes) {
        const isRegEx = regEx.match(/^\/(.+)\/(.*)$/);
        if (isRegEx) {
            matched = author_association.match(new RegExp(isRegEx[1], isRegEx[2]));
        }
        else {
            matched = author_association.match(regEx);
        }
        if (!matched) {
            return false;
        }
    }
    return true;
}
function getLabels(client, issue_number) {
    return __awaiter(this, void 0, void 0, function* () {
        const labels = new Set();
        try {
            const response = yield client.rest.issues.listLabelsOnIssue({
                owner: github.context.repo.owner,
                repo: github.context.repo.repo,
                issue_number
            });
            core.debug(`Load labels status ${response.status}`);
            const data = response.data;
            for (let i = 0; i < Object.keys(data).length; i++) {
                labels.add(data[i].name);
            }
            return labels;
        }
        catch (error) {
            core.warning(`Unable to load labels. (${error})`);
            return labels;
        }
    });
}
function addLabels(client, issue_number, labels) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const response = yield client.rest.issues.addLabels({
                owner: github.context.repo.owner,
                repo: github.context.repo.repo,
                issue_number,
                labels
            });
            core.debug(`Add labels status ${response.status}`);
        }
        catch (error) {
            core.warning(`Unable to add labels. (${error})`);
        }
    });
}
function removeLabel(client, issue_number, name) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const response = yield client.rest.issues.removeLabel({
                owner: github.context.repo.owner,
                repo: github.context.repo.repo,
                issue_number,
                name
            });
            core.debug(`Remove label \`${name}\` status ${response.status}`);
        }
        catch (error) {
            core.warning(`Unable to remove label ${name}. (${error})`);
        }
    });
}
function addComment(client, issue_number, body) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const response = yield client.rest.issues.createComment({
                owner: github.context.repo.owner,
                repo: github.context.repo.repo,
                issue_number,
                body
            });
            core.debug(`Add comment \`${body.split('\n').join('\\n')}\` status ${response.status}`);
        }
        catch (error) {
            core.warning(`Unable to add comment \`${body.split('\n').join('\\n')}\`. (${error})`);
        }
    });
}
run();
