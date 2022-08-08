import * as core from '@actions/core';
import * as github from '@actions/github';
import { Octokit } from '@octokit/core';
import * as yaml from 'js-yaml';

// content, [name, regexes, disabled-if]
type item_t = Map<string, [string, string[], string[]]>;

async function run(): Promise<void> {
  try {
    // Configuration parameters
    const configPath: string = core.getInput('configuration-path', { required: true });
    const token: string = core.getInput('repo-token', { required: true });
    const notBefore: number = Date.parse(core.getInput('not-before', { required: false }));
    const includeTitle: number = parseInt(core.getInput('include-title', { required: false }));
    const syncLabels: number = parseInt(core.getInput('sync-labels', { required: false }));

    const [issue_number, issue_title, issue_body]:
      [number, string, string] = getIssueOrPullRequestInfo();

    // A client to load data from GitHub
    const client = github.getOctokit(token);

    // If the notBefore parameter has been set to a valid timestamp, exit if the current issue was created before notBefore
    if (notBefore) {
      const issueCreatedAt: number = Date.parse(github.context.payload.created_at)
      core.info(`Issue is created at ${github.context.payload.created_at}.`)
      if (Number.isNaN(issueCreatedAt)) {
        throw Error(
          `Cannot deduce \`issueCreatedAt\` from ${github.context.payload.created_at}.`
        );
      } else if (issueCreatedAt < notBefore) {
        core.notice("Issue is before `notBefore` configuration parameter. Exiting...");
        return;
      }
    } else {
      core.debug(`Parameter \`notBefore\` is not set or is set invalid.`);
    }

    // Load our regex rules from the configuration path
    const itemsPromise: Promise<[item_t, item_t]> = getLabelCommentRegexes(
      client,
      configPath
    );
    // Get the labels have been added to the current issue
    const labelsPromise: Promise<Set<string>> = getLabels(
      client,
      issue_number
    );

    const [labelParams, commentParams]: [item_t, item_t] = await itemsPromise;
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
    );

    // comments to be added & removed(no sense)
    var [addCommentItems, removeCommentItems]: [string[], string[]] = itemAnalyze(
      commentParams,
      issueContent,
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
  itemParams: item_t,
  issueContent: string,
): [string[], string[]] {
  const addItems: string[] = []
  const addItemNames: Set<string> = new Set();
  const removeItems: string[] = []

  for (const [item, [itemName, globs, avoidItems]] of itemParams.entries()) {
    if (avoidItems.filter(avoidItem => addItemNames.has(avoidItem)).length == 0 &&
      checkRegexes(issueContent, globs)) {
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
  [number, string, string] {
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
    return [
      issue.number,
      issue.title === null ? "" : issue.title,
      issue.body === null ? "" : issue.body,
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
    return [
      pull_request.number,
      pull_request.title === null ? "" : pull_request.title,
      pull_request.body === null ? "" : pull_request.body,
    ];
  }

  throw Error(
    `could not get issue or pull request number from context`
  );
}

async function getLabelCommentRegexes(
  client: any,
  configurationPath: string
): Promise<[item_t, item_t]> {
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

  // transform `any` => `item_t` or throw if yaml is malformed:
  return getParamsMapFromObject(configObject);
}

function getItemParamsFromItem(item: any): [string, string, string[], string[]] {
  const itemMap: Map<string, any> = new Map();
  for (const key in item) {
    if (key == "name") {
      if (typeof item[key] === 'string') {
        itemMap.set(key, item[key]);
      } else {
        throw Error(
          `found unexpected type for item name \`${item[key]}\` (should be string)`
        );
      }
    } else if (key == "content") {
      if (typeof item[key] === 'string') {
        itemMap.set(key, item[key]);
      } else {
        const itemRepr: string = itemMap.has("name") ? itemMap.get("name") : "some item";
        throw Error(
          `found unexpected type of field \`content\` in ${itemRepr} (should be string)`
        );
      }
    } else if (key == "regexes") {
      if (typeof item[key] === 'string') {
        itemMap.set(key, [item[key]]);
      } else if (Array.isArray(item[key])) {
        itemMap.set(key, item[key]);
      } else {
        const itemRepr: string = itemMap.has("name") ? itemMap.get("name") : "some item";
        throw Error(
          `found unexpected type of field \`regexes\` in ${itemRepr} (should be string or array of regex)`
        );
      }
    } else if (key == "disabled-if") {
      if (typeof item[key] === 'string') {
        itemMap.set(key, [item[key]]);
      } else if (Array.isArray(item[key])) {
        itemMap.set(key, item[key]);
      } else {
        const itemRepr: string = itemMap.has("name") ? itemMap.get("name") : "some item";
        throw Error(
          `found unexpected type of field \`disabled-if\` in ${itemRepr} (should be string or array of string)`
        );
      }
    }
  }

  if (!itemMap.has("name")) {
    throw Error(
      `some item's name is missing`
    );
  }
  if (!itemMap.has("regexes")) {
    const itemRepr: string = itemMap.has("name") ? itemMap.get("name") : "some item";
    throw Error(
      `${itemRepr}'s regexes are missing`
    );
  }

  const itemName: string = itemMap.get("name");
  const itemContent: string = itemMap.has("content") ? itemMap.get("content") : itemName;
  const itemRegexes: string[] = itemMap.get("regexes");
  const itemAvoid: string[] = itemMap.has("disabled-if") ? itemMap.get("disabled-if") : [];
  return [itemName, itemContent, itemRegexes, itemAvoid];
}

function getItemParamsMapFromObject(configObject: any): item_t {
  const itemParams: item_t = new Map();
  for (const item of configObject) {
    const [itemName, itemContent, itemRegexes, itemAvoid]:
      [string, string, string[], string[]] = getItemParamsFromItem(item);
    itemParams.set(itemContent, [itemName, itemRegexes, itemAvoid]);
  }
  return itemParams;
}

function getParamsMapFromObject(configObject: any): [item_t, item_t] {
  var labelParams: item_t = new Map();
  var commentParams: item_t = new Map();
  for (const key in configObject) {
    if (key === 'labels') {
      labelParams = getItemParamsMapFromObject(configObject[key]);
    } else if (key === 'comments') {
      commentParams = getItemParamsMapFromObject(configObject[key]);
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
      core.warning("Unable to load labels.");
    } else {
      const data = response.data
      for (let i = 0; i < Object.keys(data).length; i++) {
        labels.add(data[i].name)
      }
    }
    return labels;
  } catch (error) {
    core.warning("Unable to load labels.");
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
      core.warning("Unable to add labels.");
    }
  } catch (error) {
    core.warning("Unable to add labels.");
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
      core.warning(`Unable to remove label ${name}.`);
    }
  } catch (error) {
    core.warning(`Unable to remove label ${name}.`);
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
      core.warning(`Unable to add comment ${body}.`);
    }
  } catch (error) {
    core.warning(`Unable to add comment ${body}.`);
  }
}

run();
