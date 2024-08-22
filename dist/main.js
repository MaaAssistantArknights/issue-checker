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
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const github = __importStar(require("@actions/github"));
const yaml = __importStar(require("js-yaml"));
async function run() {
    try {
        // Configuration parameters
        const configPath = core.getInput('configuration-path', {
            required: true
        });
        const token = core.getInput('repo-token', { required: true });
        const notBefore = Date.parse(core.getInput('not-before', { required: false }));
        const includeTitle = parseInt(core.getInput('include-title', { required: false }));
        const syncLabels = parseInt(core.getInput('sync-labels', { required: false }));
        const { event_name: _event_name, issue_number: issue_number, title: title, body: body, created_at: created_at, author_association: author_association } = getEventInfo();
        const event_name = getModeEvent(_event_name);
        if (event_name === undefined) {
            throw Error(`could not handle event \`${_event_name}\``);
        }
        if (core.isDebug()) {
            core.debug(`event_name: ${event_name}`);
            core.debug(`issue_number: ${issue_number}`);
            core.debug(`title: ${title}`);
            core.debug(`body: ${body}`);
            core.debug(`created_at: ${created_at}`);
            core.debug(`author_association: ${author_association}`);
        }
        const issueContent = (includeTitle === 1 ? `${title}\n\n` : '') + body;
        core.info(`Content of issue #${issue_number}:\n${issueContent}`);
        // A client to load data from GitHub
        const client = github.getOctokit(token);
        if (event_name === 'push' /* || event_name === 'commit_comment'*/) {
            if (issue_number && Array.isArray(issue_number)) {
                for (const issue of issue_number) {
                    core.notice(`This push fixed issue #${issue}.`);
                    addLabels(client, issue, ['fixed']);
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
            const [labelParams, commentParams] = await loadConfigRules(client, configPath, syncLabels);
            const issueLabels = await getCurrentLabels(client, issue_number);
            // labels to be added & removed
            const LabelAnalyzeResult = ruleAnalyze(labelParams, issueContent, author_association, event_name);
            let addLabelItems = LabelAnalyzeResult[0];
            const removeLabelItems = LabelAnalyzeResult[1];
            // comments to be added
            const addCommentItems = ruleAnalyze(commentParams, issueContent, author_association, event_name)[0];
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
}
function ruleAnalyze(itemMap, issueContent, author_association, event_name) {
    const addItems = [];
    const addItemNames = new Set();
    const removeItems = [];
    for (const itemParams of itemMap) {
        const item = itemParams.content ?? '';
        const itemName = itemParams.name;
        const globs = itemParams.regexes;
        const allowedAuthorAssociation = itemParams.author_association;
        const mode = itemParams.mode;
        const skipIf = itemParams.skip_if;
        const removeIf = itemParams.remove_if;
        const needAdd = checkEvent(event_name, mode, 'add');
        const needRemove = checkEvent(event_name, mode, 'remove');
        core.debug(`item \`${itemName}\` (needAdd = ${needAdd}, needRemove = ${needRemove}, mode = ${JSON.stringify(mode)})`);
        if (skipIf.filter(x => addItemNames.has(x)).length > 0) {
            // 此项的 skip-if 中包含待添加的项，直接跳过
            if (core.isDebug()) {
                core.debug(`Skip item, because skip_if \`${skipIf}\` contains some item in added items \`${Array.from(addItemNames)}\``);
            }
            continue;
        }
        if (removeIf.filter(x => addItemNames.has(x)).length > 0) {
            // 此项的 remove-if 中包含待添加的项，直接删除，优先级高于 needRemove
            if (item !== '' && !removeItems.includes(item)) {
                if (core.isDebug()) {
                    core.debug(`Remove item, because remove_if \`${removeIf}\` contains some item in added items \`${Array.from(addItemNames)}\``);
                }
                removeItems.push(item);
            }
            continue;
        }
        if (checkAuthorAssociation(author_association, allowedAuthorAssociation) &&
            checkRegexes(issueContent, globs)) {
            if (needAdd) {
                if (item !== '' && !addItems.includes(item)) {
                    addItems.push(item);
                }
                addItemNames.add(itemName);
            }
        }
        else if (needRemove && item !== '' && !removeItems.includes(item)) {
            removeItems.push(item);
        }
    }
    // 返回需要添加的项和需要删除的项，删除优先级高于添加
    return [addItems.filter(item => !removeItems.includes(item)), removeItems];
}
function getEventInfo() {
    const getEventDetails = (issue) => {
        return {
            event_name: github.context.eventName,
            issue_number: issue.number ?? NaN,
            title: issue.title ?? '',
            body: issue.body ?? '',
            created_at: issue.created_at ?? '',
            author_association: issue.author_association ?? ''
        };
    };
    const payload = github.context.payload;
    const event_name = github.context.eventName;
    if (event_name === 'issues') {
        return getEventDetails(payload.issue ?? {});
    }
    if (event_name === 'pull_request_target' || event_name === 'pull_request') {
        return getEventDetails(payload.pull_request ?? {});
    }
    if (event_name === 'issue_comment') {
        const eventInfo = getEventDetails(payload.comment ?? {});
        eventInfo.issue_number = payload.issue?.number ?? NaN;
        eventInfo.title = payload.issue?.title ?? '';
        return eventInfo;
    }
    if (event_name === 'push') {
        let messages = '';
        for (const commit of payload.commits)
            messages += `${commit.message}\n\n`;
        const issue_numbers = [];
        const globs = /(?:[Ff]ix|[Cc]lose)\s+(?:#|.*\/issues\/)(\d+)/;
        let matchResult = messages.match(globs);
        while (matchResult && matchResult.index) {
            issue_numbers.push(parseInt(matchResult[1]));
            messages = messages.slice(matchResult.index + matchResult[0].length);
            matchResult = messages.match(globs);
        }
        return {
            event_name: event_name,
            issue_number: issue_numbers,
            title: '',
            body: messages,
            created_at: '1970-01-01T00:00:00Z', // TODO
            author_association: '' // TODO
        };
    }
    throw Error(`could not handle event \`${event_name}\``);
}
async function loadConfigRules(client, configurationPath, syncLabels) {
    const response = await client.rest.repos.getContent({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        path: configurationPath,
        ref: github.context.sha
    });
    const data = response.data;
    if (!data.content) {
        throw Error(`the configuration path provides an invalid file`);
    }
    const configObject = yaml.load(Buffer.from(data.content, 'base64').toString('utf8'));
    // transform `any` => `item_t[]` or throw if yaml is malformed:
    return getArraysFromObject(configObject, syncLabels);
}
function getItemParamsFromItem(item, default_mode) {
    if (item === null || typeof item !== 'object') {
        throw Error(`found unexpected type of configuration object`);
    }
    const is_str = (x) => typeof x === 'string';
    const is_strarr = (x) => Array.isArray(x);
    const is_null = (x) => x === null;
    const nopred = (x) => x;
    const pred_2arr = (x) => [x];
    const pred_2emptystr = () => '';
    const str2str = {
        cond: is_str,
        pred: nopred
    };
    const str2strarr = {
        cond: is_str,
        pred: pred_2arr
    };
    const strarr2strarr = {
        cond: is_strarr,
        pred: nopred
    };
    const null2str = {
        cond: is_null,
        pred: pred_2emptystr
    };
    const mode_cond_pred = {
        cond: () => true,
        pred: getModeFromObject
    };
    const configMap = {
        name: [str2str],
        content: [str2str, null2str],
        author_association: [str2strarr, strarr2strarr],
        regexes: [str2strarr, strarr2strarr],
        mode: [mode_cond_pred],
        skip_if: [str2strarr, strarr2strarr],
        remove_if: [str2strarr, strarr2strarr]
    };
    const itemParams = {
        name: '',
        content: undefined,
        author_association: [],
        regexes: [],
        mode: default_mode,
        skip_if: [],
        remove_if: []
    };
    for (const key in item) {
        // skip-if -> skip_if, ...
        const replaced_key = key.replace('-', '_');
        if (replaced_key in configMap) {
            const value = item[key];
            const cond_preds = configMap[replaced_key];
            for (const cond_pred of cond_preds) {
                if (cond_pred.cond(value)) {
                    itemParams[replaced_key] = cond_pred.pred(value);
                    break;
                }
            }
            if (!(replaced_key in itemParams)) {
                const itemRepr = itemParams.name ?? 'some item';
                throw Error(`found unexpected \`${value}\` (type \`${typeof key}\`) of field \`${key}\` in ${itemRepr}`);
            }
        }
        else {
            throw Error(`found unexpected field \`${key}\``);
        }
    }
    if (!itemParams.name) {
        throw Error(`some item's name is missing`);
    }
    itemParams.content ??= itemParams.name;
    return itemParams;
}
function getModeEvent(modeItem) {
    return modeItem === 'pull_request' ||
        modeItem === 'pull_request_target' ||
        modeItem === 'issues' ||
        modeItem === 'issue_comment' ||
        modeItem === 'push'
        ? modeItem
        : undefined;
}
function appendMode(mode, modeKey, modeItems = true) {
    if (modeKey === 'add' || modeKey === 'remove') {
        if (mode[modeKey] === true) {
        }
        else if (modeItems === true) {
            mode[modeKey] = true;
        }
        else {
            mode[modeKey] ??= [];
            for (const modeItem of modeItems) {
                const modeItemValue = getModeEvent(modeItem);
                if (!modeItemValue) {
                    throw Error(`found unexpected value \`${modeItem}\``);
                }
                mode[modeKey].push(modeItemValue);
            }
        }
        return;
    }
    const modeItemValue = getModeEvent(modeKey);
    if (modeItemValue) {
        if (modeItems === true) {
            modeItems = ['add', 'remove'];
        }
        for (const modeItem of modeItems) {
            if (modeItem === 'add') {
                mode.add ??= [];
                if (mode.add !== true)
                    mode.add.push(modeItemValue);
            }
            else if (modeItem === 'remove') {
                mode.remove ??= [];
                if (mode.remove !== true)
                    mode.remove.push(modeItemValue);
            }
            else {
                throw Error(`found unexpected value \`${modeItem}\``);
            }
        }
    }
    else {
        throw Error(`found unexpected value \`${modeKey}\``);
    }
}
function getModeFromObject(configObject) {
    const modeMap = { add: [], remove: [] };
    if (typeof configObject === 'string') {
        appendMode(modeMap, configObject);
    }
    else if (Array.isArray(configObject)) {
        for (const value of configObject) {
            if (typeof value !== 'string') {
                throw Error(`found unexpected type of configuration object`);
            }
            appendMode(modeMap, value);
        }
    }
    else if (configObject !== null && typeof configObject === 'object') {
        for (const key in configObject) {
            const value = configObject[key];
            if (value === null) {
                appendMode(modeMap, key, true);
            }
            else if (typeof value === 'string') {
                appendMode(modeMap, key, [value]);
            }
            else if (Array.isArray(value)) {
                appendMode(modeMap, key, value);
            }
            else {
                throw Error(`found unexpected type of configuration object`);
            }
        }
    }
    return modeMap;
}
function getItemArrayFromObject(configObject, default_mode) {
    const itemArray = [];
    if (!Array.isArray(configObject)) {
        throw Error(`found unexpected type of configuration object`);
    }
    for (const item of configObject) {
        const itemParams = getItemParamsFromItem(item, default_mode);
        itemArray.push(itemParams);
    }
    return itemArray;
}
function getArraysFromObject(configObject, syncLabels) {
    if (configObject === null || typeof configObject !== 'object') {
        throw Error(`found unexpected type of configuration object`);
    }
    for (const key in configObject) {
        if (key === 'labels' || key === 'comments' || key === 'default-mode') {
            continue;
        }
        throw Error(`found unexpected field \`${key}\``);
    }
    const labelParamsObject = 'labels' in configObject ? configObject.labels : [];
    const commentParamsObject = 'comments' in configObject ? configObject.comments : [];
    let default_mode = 'default-mode' in configObject
        ? getModeFromObject(configObject['default-mode'])
        : undefined;
    let labelParams = [];
    let commentParams = [];
    if (default_mode === undefined) {
        if (syncLabels === 1) {
            default_mode = {
                add: true,
                remove: true
            };
        }
        else if (syncLabels === 0) {
            default_mode = { add: true, remove: [] };
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
function checkEvent(event_name, mode, type) {
    const type_mode = mode[type];
    return (type_mode !== undefined &&
        (type_mode === true || type_mode.includes(event_name)));
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
async function getCurrentLabels(client, issue_number) {
    const labels = new Set();
    try {
        const response = await client.rest.issues.listLabelsOnIssue({
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
}
async function addLabels(client, issue_number, labels) {
    try {
        const response = await client.rest.issues.addLabels({
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
}
async function removeLabel(client, issue_number, name) {
    try {
        const response = await client.rest.issues.removeLabel({
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
}
async function addComment(client, issue_number, body) {
    try {
        const response = await client.rest.issues.createComment({
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
}
run();
//# sourceMappingURL=main.js.map