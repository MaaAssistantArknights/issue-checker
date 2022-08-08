import * as core from '@actions/core';
import * as github from '@actions/github';
import { Octokit } from '@octokit/core';
import * as yaml from 'js-yaml';

// {name, content, regexes, author_association, disabled-if}
type item_t = Map<string, any>;

async function run(): Promise<void> {
  try {
    // Configuration parameters
    const configPath: string = core.getInput('configuration-path', { required: true });
    const token: string = core.getInput('repo-token', { required: true });
    const notBefore: number = Date.parse(core.getInput('not-before', { required: false }));
    const includeTitle: number = parseInt(core.getInput('include-title', { required: false }));
    const syncLabels: number = parseInt(core.getInput('sync-labels', { required: false }));

    const [issue_number, issue_title, issue_body, issue_author_association]:
      [number, string, string, string] = getIssueOrPullRequestInfo();
    if(core.isDebug()) {
      core.debug(`issue_number: ${issue_number}`)
      core.debug(`issue_title: ${issue_title}`)
      core.debug(`issue_body: ${issue_body}`)
      core.debug(`issue_author_association: ${issue_author_association}`)
    }
    // A client to load data from GitHub
    const client = github.getOctokit(token);

    // If the notBefore parameter has been set to a valid timestamp, exit if the current issue was created before notBefore
    if (notBefore) {
      var issue_created_at: string = "";
      if (github.context.payload.issue) {
        issue_created_at = github.context.payload.issue.created_at;
      } else if (github.context.payload.pull_request) {
        issue_created_at = github.context.payload.pull_request.created_at;
      }
      const issueCreatedAt: number = Date.parse(issue_created_at)
      core.info(`Issue is created at ${issue_created_at}.`)
      if (Number.isNaN(issueCreatedAt)) {
        throw Error(
          `Cannot deduce \`issueCreatedAt\` from ${issue_created_at}.`
        );
      } else if (issueCreatedAt < notBefore) {
        core.notice("Issue is before `notBefore` configuration parameter. Exiting...");
        return;
      }
    } else {
      core.debug(`Parameter \`notBefore\` is not set or is set invalid.`);
    }

    // Load our regex rules from the configuration path
    const itemsPromise: Promise<[Array<item_t>, Array<item_t>]> = getLabelCommentArrays(
      client,
      configPath
    );
    // Get the labels have been added to the current issue
    const labelsPromise: Promise<Set<string>> = getLabels(
      client,
      issue_number
    );

    const [labelParams, commentParams]: [Array<item_t>, Array<item_t>] = await itemsPromise;
    const issueLabels: Set<string> = await labelsPromise;

    let issueContent: string = ""
    if (includeTitle === 1) {
      issueContent += `${issue_title}\n\n`;
    }
    issueContent += issue_body;

    core.info(`Content of issue #${issue_number}:\n${issueContent}`)

    // labels to be added & removed
    var [addLabelItems, removeLabelItems]: [string[], string[]] = itemAnalyze(
      labelParams,
      issueContent,
      issue_author_association,
    );

    // comments to be added & removed(no sense)
    var [addCommentItems, removeCommentItems]: [string[], string[]] = itemAnalyze(
      commentParams,
      issueContent,
      issue_author_association,
    );

    if (core.isDebug()) {
      core.debug(`labels have been added: [${Array.from(issueLabels)}]`);
      core.debug(`labels to be added: [${addLabelItems.toString()}]`);
      core.debug(`labels to be removed: [${removeLabelItems.toString()}]`);
    }

    // some may have been added, remove them
    addLabelItems = addLabelItems.filter(label => !issueLabels.has(label));
    if (addLabelItems.length > 0) {
      core.info(`Adding labels ${addLabelItems.toString()} to issue #${issue_number}`)
      addLabels(client, issue_number, addLabelItems)
    }

    if (syncLabels) {
      removeLabelItems.forEach(function (label, index) {
        // skip labels that have not been added
        if (issueLabels.has(label)) {
          core.info(`Removing label ${label} from issue #${issue_number}`)
          removeLabel(client, issue_number, label)
        }
      });
    }

    if (addCommentItems.length > 0) {
      addCommentItems.forEach(function (body, index) {
        core.info(`Comment ${body} to issue #${issue_number}`)
        addComment(client, issue_number, body)
      });
    }
  } catch (error) {
    if (error instanceof Error) {
      core.error(error);
      core.setFailed(error.message);
    }
  }
}

function itemAnalyze(
  itemMap: Array<item_t>,
  issueContent: string,
  issue_author_association: string,
): [string[], string[]] {
  const addItems: string[] = []
  const addItemNames: Set<string> = new Set();
  const removeItems: string[] = []

  for (const itemParams of itemMap) {
    const item: string = itemParams.get("content");
    const itemName: string = itemParams.get("name");
    const globs: string[] = itemParams.get("regexes");
    const author_association: string[] = itemParams.get("author_association");
    const avoidItems: string[] = itemParams.get("disabled-if");
    if (avoidItems.filter(avoidItem => addItemNames.has(avoidItem)).length == 0 &&
      checkRegexes(issueContent, globs) &&
      checkAuthorAssociation(issue_author_association, author_association)) {
      addItems.push(item);
      addItemNames.add(itemName);
    }
    else {
      removeItems.push(item);
    }
  }
  return [addItems, removeItems];
}

function getIssueOrPullRequestInfo():
  [number, string, string, string] {
  const issue = github.context.payload.issue;
  if (issue) {
    if (issue.title === undefined) {
      throw Error(
        `could not get issue title from context`
      );
    }
    if (issue.body === undefined) {
      throw Error(
        `could not get issue body from context`
      );
    }
    if (issue.author_association === undefined) {
      throw Error(
        `could not get issue author_association from context`
      );
    }
    return [
      issue.number,
      issue.title === null ? "" : issue.title,
      issue.body === null ? "" : issue.body,
      issue.author_association === null ? "" : issue.author_association,
    ];
  }

  const pull_request = github.context.payload.pull_request;
  if (pull_request) {
    if (pull_request.title === undefined) {
      throw Error(
        `could not get pull request title from context`
      );
    }
    if (pull_request.body === undefined) {
      throw Error(
        `could not get pull request body from context`
      );
    }
    if (pull_request.author_association === undefined) {
      throw Error(
        `could not get pull request author_association from context`
      );
    }
    return [
      pull_request.number,
      pull_request.title === null ? "" : pull_request.title,
      pull_request.body === null ? "" : pull_request.body,
      pull_request.author_association === null ? "" : pull_request.author_association,
    ];
  }

  throw Error(
    `could not get issue or pull request from context`
  );
}

async function getLabelCommentArrays(
  client: any,
  configurationPath: string
): Promise<[Array<item_t>, Array<item_t>]> {
  const response = await client.rest.repos.getContent({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    path: configurationPath,
    ref: github.context.sha
  });

  const data: any = response.data
  if (!data.content) {
    throw Error(
      `the configuration path provides an invalid file`
    );
  }

  const configurationContent: string = Buffer.from(data.content, 'base64').toString('utf8');
  const configObject: any = yaml.load(configurationContent);

  // transform `any` => `Array<item_t>` or throw if yaml is malformed:
  return getArraysFromObject(configObject);
}

function getItemParamsFromItem(item: any): Map<string, any> {
  const itemParams: Map<string, any> = new Map();
  for (const key in item) {
    if (key == "name") {
      if (typeof item[key] === 'string') {
        itemParams.set(key, item[key]);
      } else {
        throw Error(
          `found unexpected type for item name \`${item[key]}\` (should be string)`
        );
      }
    } else if (key == "content") {
      if (typeof item[key] === 'string') {
        itemParams.set(key, item[key]);
      } else {
        const itemRepr: string = itemParams.has("name") ? itemParams.get("name") : "some item";
        throw Error(
          `found unexpected type of field \`content\` in ${itemRepr} (should be string)`
        );
      }
    } else if (key == "author_association") {
      if (typeof item[key] === 'string') {
        itemParams.set(key, [item[key]]);
      } else if (Array.isArray(item[key])) {
        itemParams.set(key, item[key]);
      } else {
        const itemRepr: string = itemParams.has("name") ? itemParams.get("name") : "some item";
        throw Error(
          `found unexpected type of field \`author_association\` in ${itemRepr} (should be string or array of regex)`
        );
      }
    } else if (key == "regexes") {
      if (typeof item[key] === 'string') {
        itemParams.set(key, [item[key]]);
      } else if (Array.isArray(item[key])) {
        itemParams.set(key, item[key]);
      } else {
        const itemRepr: string = itemParams.has("name") ? itemParams.get("name") : "some item";
        throw Error(
          `found unexpected type of field \`regexes\` in ${itemRepr} (should be string or array of regex)`
        );
      }
    } else if (key == "disabled-if") {
      if (typeof item[key] === 'string') {
        itemParams.set(key, [item[key]]);
      } else if (Array.isArray(item[key])) {
        itemParams.set(key, item[key]);
      } else {
        const itemRepr: string = itemParams.has("name") ? itemParams.get("name") : "some item";
        throw Error(
          `found unexpected type of field \`disabled-if\` in ${itemRepr} (should be string or array of string)`
        );
      }
    }
  }

  if (!itemParams.has("name")) {
    throw Error(
      `some item's name is missing`
    );
  }
  if (!itemParams.has("regexes") && !itemParams.has("author_association")) {
    const itemRepr: string = itemParams.has("name") ? itemParams.get("name") : "some item";
    throw Error(
      `${itemRepr}'s \`regexes\` or \`author_association\` are missing`
    );
  }

  const itemName: string = itemParams.get("name");
  if (!itemParams.has("content")) {
    itemParams.set("content", itemName);
  }
  if (!itemParams.has("regexes")) {
    itemParams.set("regexes", []);
  }
  if (!itemParams.has("author_association")) {
    itemParams.set("author_association", []);
  }
  if (!itemParams.has("disabled-if")) {
    itemParams.set("disabled-if", []);
  }
  return itemParams;
}

function getItemArrayFromObject(configObject: any): Array<item_t> {
  const itemArray: Array<item_t> = new Array();
  for (const item of configObject) {
    const itemParams: item_t = getItemParamsFromItem(item);
    itemArray.push(itemParams);
  }
  return itemArray;
}

function getArraysFromObject(configObject: any): [Array<item_t>, Array<item_t>] {
  var labelParams: Array<item_t> = new Array();
  var commentParams: Array<item_t> = new Array();
  for (const key in configObject) {
    if (key === 'labels') {
      labelParams = getItemArrayFromObject(configObject[key]);
    } else if (key === 'comments') {
      commentParams = getItemArrayFromObject(configObject[key]);
    } else {
      throw Error(
        `found unexpected key for ${key} (should be \`labels\` or \`comments\`)`
      );
    }
  }
  return [labelParams, commentParams];
}

function checkRegexes(issue_body: string, regexes: string[]): boolean {
  var matched;

  // If several regex entries are provided we require all of them to match for the label to be applied.
  for (const regEx of regexes) {
    const isRegEx = regEx.match(/^\/(.+)\/(.*)$/)

    if (isRegEx) {
      matched = issue_body.match(new RegExp(isRegEx[1], isRegEx[2]))
    } else {
      matched = issue_body.match(regEx)
    }

    if (!matched) {
      return false;
    }
  }
  return true;
}

function checkAuthorAssociation(
  issue_author_association: string,
  regexes: string[],
): boolean {
  var matched;

  // If several regex entries are provided we require all of them to match for the label to be applied.
  for (const regEx of regexes) {
    const isRegEx = regEx.match(/^\/(.+)\/(.*)$/)

    if (isRegEx) {
      matched = issue_author_association.match(new RegExp(isRegEx[1], isRegEx[2]))
    } else {
      matched = issue_author_association.match(regEx)
    }

    if (!matched) {
      return false;
    }
  }
  return true;
}

async function getLabels(
  client: any,
  issue_number: number,
): Promise<Set<string>> {
  const labels: Set<string> = new Set();
  try {
    const response = await client.rest.issues.listLabelsOnIssue({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number: issue_number,
    });
    if (response.status != 200) {
      core.warning(`Unable to load labels, status ${response.status}`);
    } else {
      const data = response.data
      for (let i = 0; i < Object.keys(data).length; i++) {
        labels.add(data[i].name)
      }
    }
    return labels;
  } catch (error) {
    core.warning(`Unable to load labels. (${error})`);
    return labels;
  }
}

async function addLabels(
  client: any,
  issue_number: number,
  labels: string[]
): Promise<void> {
  try {
    const response = await client.rest.issues.addLabels({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number: issue_number,
      labels: labels
    });
    if (response.status != 200) {
      core.warning(`Unable to add labels, status ${response.status}`);
    }
  } catch (error) {
    core.warning(`Unable to add labels. (${error})`);
  }
}

async function removeLabel(
  client: any,
  issue_number: number,
  name: string
): Promise<void> {
  try {
    const response = await client.rest.issues.removeLabel({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number: issue_number,
      name: name
    });
    if (response.status != 200) {
      core.warning(`Unable to remove label ${name}, status ${response.status}`);
    }
  } catch (error) {
    core.warning(`Unable to remove label ${name}. (${error})`);
  }
}

async function addComment(
  client: any,
  issue_number: number,
  body: string
): Promise<void> {
  try {
    const response = await client.rest.issues.createComment({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number: issue_number,
      body: body
    });
    if (response.status != 200) {
      core.warning(`Unable to add comment ${body}, status ${response.status}`);
    }
  } catch (error) {
    core.warning(`Unable to add comment ${body}. (${error})`);
  }
}

run();
